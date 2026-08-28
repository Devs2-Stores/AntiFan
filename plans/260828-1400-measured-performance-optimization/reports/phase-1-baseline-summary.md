| 1 — Baseline instrumentation and gates | **Baseline subset complete** (recorded below); plan-matrix scenarios not yet implemented are listed under "Not yet measured" |
| 2 — Tab lifecycle and resource reclamation | **Blocked** on pending QA reliability plan `260828-1033-qa-fresh-target-reliability`; read-only design evidence below |
| 3 — Main-thread QA/watcher/resize/persistence responsiveness | **Blocked** on same; read-only design evidence below |
| 4 — Terminal, bridge, and artifact I/O bounds | Unblocked; artifact binary-safety in progress |
| 5 — Startup and Windows distribution | Pending |
| 6 — Integrated verification and rollout decision | Pending |

## Not yet measured (plan scenario matrix, harness not implemented)

The Phase 1 scenario matrix also requires these observations; the harness `--scenario`
dispatch currently implements cold-start/tabs/terminal/artifact/package only. The rows below
are `unmeasured` with prerequisites — not observations.

| Plan scenario | Prerequisite to implement |
|---|---|
| Multi-tab restore | Relaunch app against the persisted isolated user-data dir, then observe `restoreTabs()` milestones (bridge `antifan.listTabs` + startup telemetry) |
| Split-review resize | Bridge split-pane RPC (`antifan.openSplit*`) or direct native-tab-host resize drive; measure layout pass count and bounds calls during continuous resize |
| QA validation (bounded + large fixture) | Fixture workspace + `theme-qa-workflow` invocation through the product surface; requires the pending QA reliability plan for target semantics |
| Bridge slow client | A deliberately throttled Bridge WS client; observe `broadcastEvent` bufferedAmount and essential-vs-transient delivery policy |

## Phase 1 run protocol (repeatable)

```
node scripts/benchmark-electron-performance.mjs --scenario all --runs 1
```

App launched in benchmark mode (`ANTIFAN_BENCHMARK=1`) with isolated `ANTIFAN_USER_DATA` /
`ANTIFAN_CONFIG_DIR` temp dirs; `ELECTRON_RUN_AS_NODE` stripped from the child env; bridge
driven over the production Bridge WebSocket (token auth from the isolated `bridge.json`).

### Authoritative baseline

`reports/phase-1-baseline-2026-08-28T13-31-53-837Z.json` (all scenarios, 2026-08-28T13:31Z,
Windows 11 Pro, Electron packaged runtime). Manifest/package row cross-checked in the same
run: `windows-x64-manifest.json` mtime 2026-08-28T13:31:53.703Z (134 ms before report write —
refreshed by this run, not stale).

| Scenario | Observation |
|---|---|
| cold-start | bootstrap → first-visible 1714 ms (1 run) |
| tabs | tab switch p50 15.4 ms, p95 259.9 ms, n=3; attached views 1 |
| terminal | interactive echo latency 3871 ms (shell-cold); burst 1544 chunks / 8346 bytes in 4519 ms |
| artifact | text-small 3.43 ms, DOM-medium 18.94 ms, png-small 4.10 ms (binary byte-equal), png-max 144.24 ms (binary byte-equal) |
| package | 317 files, 1132 MB dir, exe 225,562,624 B present, `pty.node` present; build+package ≈ 132.5 s |

### Instrumentation (all guarded by `ANTIFAN_BENCHMARK=1` / `--benchmark`)

- `src/main/benchmark/telemetry.ts` (new): prefix-tagged single-line JSON metrics, event-loop
  delay monitor, reject NaN/Infinity, `parseBenchmarkLine` null-on-invalid.
- Hooks: `src/main/index.ts` (startup milestones, process metrics, will-quit flush),
  `native-tab-host.ts` (created/switched/closed/layout), `terminal-manager.ts` (ptyData/exit),
  `bridge-server.ts` (broadcast duration/clients/bytes), `artifact-store.ts` (stage duration).
- Contract test `test/main/performance-benchmark-contract.test.ts`: 8/8 pass
  (`npm run compile && node --test .compiled/test/main/performance-benchmark-contract.test.js`).
- No metric is ever fabricated: `baselineStatus: 'unmeasured'` + exact prerequisite is emitted
  when a scenario cannot run (e.g. package compile failure path).

## Phase 2 design evidence (read-only; implementation blocked)

Anchors in `src/main/browser/native-tab-host.ts` as of 2026-08-28:

- `NativeTabRecord` (line 176) carries live `view: WebContentsView` (non-optional) plus
  `mobileView?`; a record therefore retains live WebContents after detach.
- `switchTab` (lines ~2564-2571) removes `target.view`/`mobileView` from the window's
  `contentView` but does not destroy or release them; the record stays in `tabs` with full
  event wiring → the plan's "keep inactive tab records and their WebContentsView instances"
  finding is confirmed at the source level.
- `closeTab` teardown (lines ~2367-2373, 4982-4995) already removes views and destroys
  WebContents, so a shared teardown/destroy helper is the natural seam for discard.
- A discard design must reuse that teardown path minus record deletion, guard against active
  agent/automation/inspection/audio/split-pane state, capture scroll before discard (bounded),
  and rehydrate through the existing secure WebContents creation path with generation
  invalidation. Full design: plan Phase 2 sections (files, checklist, test matrix).
- Not implemented: the pending QA reliability plan owns overlapping tab/reload/target
  contracts (`theme-qa-workflow.ts`, fresh-target semantics). Reconcile before landing.

## Phase 3 design evidence (read-only; implementation blocked)

- `ThemeQaWorkflow.validate` sequential path: pre-navigation diagnostics snapshot ordering and
  fresh-target/load-stable generation guarantees must be preserved; worker offload only for
  measured pure-scanning segments (no QA truth change).
- `PreviewWatcherPool`: verified batched via Set with a 150 ms debounce — coalescing already
  exists; do not touch without burst measurements and ignored-path tests.
- `NativeTabHost.persistTabs()` (line 3864) writes with synchronous `fs.writeFileSync`
  (line 3923) behind a 400 ms timer (line 3859-3861) — measured candidate only if the
  benchmark shows main-thread block; async atomic write must keep latest-write-wins and the
  existing temp/rename/fallback semantics.
- Resize/CDP calls in `updateLayout` are already fire-and-forget for emulation; only geometry
  coalescing at the layout boundary is in scope.

## Adoption gate (Phase 6)

A later change is adopted only when its target scenario improves over the Phase 1 samples for
that scenario, relevant contract tests stay green, and unrelated p95 does not regress beyond
recorded measurement noise. No unmeasured figure in this record is presented as an observation.