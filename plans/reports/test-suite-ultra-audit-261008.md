# Test Suite Ultra Audit — ak:test --ultra --advice (audit mode)
Date: 2026-10-08 · Repo: AntiFan Desktop · Mode: best-of-5 verifier union (5 candidates + kongming verifier)
ultra: union=30/41 single_candidate_only=23
Verifier verdict: **CONDITIONAL GO** — do NOT trust CI green until the P0 isolation leak + single-instance false-green bypass are patched.

Suite shape measured this run: 398 test files, ~4.4k+ assertions, 16 pipeline lanes, 439.99s wall.

## P0 — Critical integrity / false-green invariants

### U01 [P0] Incomplete environment isolation + single-instance lock false-green bypass
`run-test-pipeline.mjs:184-188` pins only `ANTIFAN_ISSUE_REGISTER_DIR` + `ANTIFAN_VERIFICATION_REGISTER_DIR`; `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR`/`ANTIFAN_USER_DATA` are absent → `storage-locations.ts:50-56` falls back to live `E:\Work\.antifan-data`. With a dev instance open, spawned Electrons fail `requestSingleInstanceLock()` (`index.ts:822-826`), log "Another instance is already running (DEV). Exiting." and **exit 0** → false-green lanes + live-data pollution (observed: 5× "held by a live instance" this run). Action: pin all five vars per lane; test-context lock failure must exit non-zero. Effort: 1-2h. Found by: all 5 candidates.

## P1 — Flakes, blindspots, deceptive tests

- **U02** Pipeline swallows failure diagnostics: `stdio:'inherit'` (`run-test-pipeline.mjs:182`), `--json` emits `{failed:[lane]}` with zero test names/stacks. Action: per-lane logs + structured failure objects. (B only)
- **U03** Test runs dirty git tree: 6 tracked `plans/**/reports/*.json` rewritten every run (mcp-dispatch-hub-probe.cjs:55, toolbar-qa-hub-empirical-probe.cjs:410, terminal-transport-sync.cjs:22). Action: tmp/artifacts output + `--persist-report` flag. (B,E)
- **U04** 767 wall-clock sleeps (498 scripts/, 269 test/): `session-activity.test.mjs` 7.4s raw, `terminal-renderer-smoke.cjs` 35+. Action: condition waiters / `mock.timers`. (A,B)
- **U05** Canary 27.9s bottleneck: `process-identity.mjs:45-52` spawns powershell.exe CIM ~12× (≈25s). Action: injected mock identity provider in unit tests. (A only)
- **U06** 21 of 24 `smoke:*` scripts + 16 orphaned smoke files (~12.5k LOC) outside the pipeline. Action: triage → graduate deterministic smokes, archive orphans. (A,E; count verified: 24 declared, 3 gated)
- **U07** Tautological deferred-check asserts: `DEFERRED_ROWS` deep-equal pins in terminal-capsule-assign:82-87/1139-44 and project-windows:102-109/2034-45 — unexecuted checks asserted as pass. Action: `test.skip()` for hardware-bound; real asserts for automatable. (A,D)
- **U08** 500+ literal pins (route count ===125, CSS `width:min(94vw,420px)`, whitespace-exact snippets, Vietnamese UI literals, window titles) — today's 6-failure incident class. Action: semantic/membership asserts. (B,D)
- **U09** Syntax-only compile tests masquerade as runtime verification: `new Function(ELEMENT_PICKER_SCRIPT)` (element-picker-resolution:943), `new vm.Script` (tab-devtools-host:433, agent-browser-script:13) — parse ≠ execute. Action: vm.runInContext + mock DOM. (D only)
- **U10** Top-level `process.env` deletes in ≥6 test/main files wipe sibling-test isolation pins. Action: scoped before/after or scrubbed env objects. (E only)
- **U11** `runAgentAction` data.code→CapabilityError propagation (today's fix) — 0 tests (`browser-control-port.ts:4316-4336`). (C only)
- **U12** Startup reconcile re-run (`index.ts:235` after intakeCrashReports) — 0 tests for intake→auto-resolve sequence. (C only)
- **U13** `agentDrag` (tab-automation-host:2147-2361, 215 lines CDP interpolation) — 0 tests. (C only)
- **U14** `executeActionSequence` (1266-1544, 278 lines) — only mocked; no direct ordering/stopOnError tests. (C only)
- **U15** `recordTransportIssue` 256-key stalest-evict cap — existing test uses 4 calls/3 keys; boundary never exercised. (C only)
- **U16** `IssueRegister` singleton reset via private-field poke `(…as unknown).instance = null` in 11 files. Action: public `resetForTesting()`. (E only)

## P2 — Structural & latent blindspots

- **U17** 16 lanes strictly sequential (247-257); DAG waves → ~280s (-36%). (A,C,E)
- **U18** electron-stub import-order fragility: import throw → file "passes" with 0 assertions; 18+ files carry the warning comment. Action: decouple boot from import + ≥1-assertion gate. (A only)
- **U19** `mcp-dispatch-ipc-surface.test.ts:164-400` regex-matches source files instead of exercising dispatch. (C only)
- **U20** `probe-rpc-surface-coverage.cjs:68-74` hardcodes 5 GUI sources; TerminalManager callers in tab-devtools-host:784, terminal-output-router:130,257, control-plane-runtime:235 unscanned. (B only)
- **U21** `plans:check` is frontmatter-spelling-only; 465/527 plans pending, exits 0 regardless. (B only)
- **U22** `browser-control-port.ts` untested: revalidateTargetInsideLock, evalInFrame, setTrackerIsolation. (C only)
- **U23** `daemon-spawner.ts` L0→L3 chain + dead-PID cleanup — only argv quoting tested. (C only)
- **U24** `flushAllSessions` mocked to noop in every teardown test; real `flushStorageData` never run. (C only)
- **U25** 22 constant-mirroring tautologies (BRIDGE_HEALTH_HEARTBEAT_MS===5000, DISK_CACHE_BYTES===…). (D only)
- **U26** 133 negative/absence pins forbid evolution permanently. (D only)
- **U27** MCP proxy spawn inherits ambient `ANTIFAN_DATA_ROOT` → test failures pollute live `bridge-client-failures.jsonl`. (E only)

## P3 — Hygiene

- **U28** Tracked compiled `.js` test artifacts alongside `.ts` (dual execution). (D only)
- **U29** Monolithic e2e drivers (project-windows 2145 lines/288 asserts; capsule-assign 1228) cascade one throw into blackout — observed today. (D only)
- **U30** `golden-slice-e2e` spins a real HTTP server inside `test:fast`. (E only)

## Verifier-resolved disagreements
- Smoke lanes excluded: **21** (A exact; E undercounted at 18).
- Fixed-delay calls: **767** measured (498 scripts/ + 269 test/).
- Env-pin leak confirmed at `run-test-pipeline.mjs:184-188` + `storage-locations.ts:50-56` + `index.ts:822-826`.

## Advisory note (--advice checkpoint)
The kongming verifier's counsel is the advisory output: remediation order = P0 isolation gate first, then Phase-1 flake/blindspot elimination (canary mock, lane log capture, report-path reroute, `resetForTesting`), then Phase-2 contract/coverage hardening (runtime-verified script tests + the 5 untested action pathways). No fixes applied — audit mode is findings-only.
