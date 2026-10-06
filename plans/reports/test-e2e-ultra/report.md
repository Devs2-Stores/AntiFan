# Full E2E Test Report — AntiFan (npm test aggregate)
Date: 2026-10-06 · Mode: `ak:test --ultra --advice` (best-of-5 triage + verifier union + kongming advisory)

## Result
`npm test` = `scripts/run-test-pipeline.mjs` full default aggregate: **14/19 lanes green, 5 lanes red, 12 reproduced failures**.
Opt-in lanes not run (by design): `test:probes`, `probe:windows-matrix`, `probe:background-full-page`, `probe:headless-full-page`.

| Lane | Result |
|---|---|
| plans:check, typecheck, check:rpc-surface, compile, test:canary, test:site-clone, test:super-core, test:integration, smoke:terminal, smoke:media-freeze, test:terminal-transport, test:terminal-rename, test:mcp-dispatch-hub, test:toolbar-qa-hub | ✅ pass |
| audit, test:fast, test:main, test:e2e:strict, smoke:site-mute | ❌ fail |

Every failed lane was re-run standalone → same failures reproduce; logs in `plans/reports/test-e2e-ultra/`.

## Union classification (advisor-revised taxonomy)
Verifier union of 5 analyzers, re-taxonomized under kongming advisory — 3 items moved OUT of `ENV_FLAKE`/`TEST_DEFECT` into production defects because they are hardcoded production timeouts / tracked P1 / real data-loss.

### PRODUCT / LATENT DEFECTS (3)
1. **Pairing-queue starvation = open P1 bottleneck B44** — `bridge-server.ts` `replenishPairingQueue` runs PowerShell `applyProtectedPathsDacl` inline; under load exceeds the 8s `/api/pairing/challenge` client budget → `pairing-grant-authority.test` fails after 4 attempts (33.7s). Production MCP handshake impact, not flake.
2. **`process-registry.ts:194` — 3000ms `taskkill /T /F` deadline** — verified: `setTimeout(()=>settle(false),3000)`. Under load taskkill exceeds 3s → `killAll` returns `killed:1/2`, orphan sweep `0/1`. Production ghost-process/port-lock risk.
3. **Project-window `mutedSites` data loss** — `native-tab-host.ts:13666` project-owner branch deliberately returns `{...existing, owners}` dropping document-level `mutedSites`. Mutes made inside a project window are lost on restart. Design intent (hub owns doc prefs) conflicts with user-visible behavior — needs a product decision, not a silent "fix".

### SPEC CONTRACT CONFLICT (1)
4. **`native-tab-host.ts:6904` web-hub retitle vs capsule-assign invariant** — `setActiveProject` retitles web hub to project name per explicit comment/commit `44ca3a73`; `terminal-capsule-assign.test` asserts startup title `AntiFan Browser` → cascade of 30s timeouts. Decide: keep multi-window UX intent (update test) or revert.

### TEST HARNESS DEFECTS (4)
5. `smoke-theme-golden-live.cjs:784` — artificial `revision <= before+2` upper bound; live Chromium batches mutations → bound too tight.
6. `resource-stability.test.ts` — TerminalManager singleton not reset → `dispose()`/`getStats` cross-test contamination.
7. `history-manager.test.ts:251` — fixed `delay(250)` vs 150ms quiet window under I/O load → use bounded polling.
8. `core-health-cli-deadline.test.ts` — 250ms spawn deadline + 2500ms test timeout too tight for Windows cold-start under lane load (borderline ENV_FLAKE; keep 6s headroom).

### REGISTER DRIFT (3)
9. `plans/bottlenecks.json` B28 — predicate `'under its own name'` vs actual title `'under its own capability name'` (test:522) → false REOPENED.
10. B43 — `FIXED_UNRECORDED`; socket-scoped guard `entry.ws !== ws` already at HEAD (`antifan-omp-mcp.cjs:1611`) → flip to closed.
11. terminal-dispose register dupe noted by verifier.

### TRUE ENV FLAKES (2)
12. `core-health` deadline settle + `orphan-sweep` — load-sensitive timing; do not re-pin, keep bounded retries. (Reconciled total: 12 = 3 latent + 1 conflict + 4 harness + 3 register + 1 flake; core-health's 2 test cases split — one harness defect, one flake.)

## Recommended next (confidence × impact)
| # | Action | Owner |
|---|---|---|
|1|Decide web-hub retitle contract (code vs test) — spec fork, needs owner decision|design|
|2|Decide project-window mutedSites persistence contract|design|
|3|Make DACL non-blocking / pre-warm pairing queue (B44)|source|
|4|Raise taskkill deadline 3s→8s + SIGKILL fallback|source|
|5|Update B28 regex; close B43|register|
|6|Fix 4 harness defects (golden bound, singleton reset, polling loop, core-health timeout)|test|

## Notes
- Bridge record pid 10696 was live → hook tests had valid authority; no bridge-induced cascade.
- Single-instance DEV lock messages observed in e2e logs — expected for live-app coexistence; did not gate.
- Advisory flag: do NOT certify the suite "clean" until B44 + taskkill deadlines are hardened; the rest is bookkeeping/harness.
