# Journal — Terminal↔Tab Affinity: User-Pick vs Agent-Ownership Split

Date: 2026-09-17. Scope: `src/main/browser/native-tab-host.ts`, `src/main/bridge/bridge-server.ts`, `src/preload/standalone-preload.ts`, `src/renderer/standalone.js`, `test/renderer/standalone-harness.ts`, `test/unit/browser/terminal-tab-affinity.test.ts`, `test/main/chromium-terminal-comprehensive-tab-interaction.test.ts`.

## Symptom (user report)

Affinity picker (🎯 badge on terminal tabs) rendered but did nothing on click, and assignments were "wrong everywhere" — picker showed tabs that didn't belong, badge showed wrong state.

## Root cause

`tab.state.terminalSessionId` conflated two semantics: USER preference (annotation/inspect target, set via `setTabTerminalSession`) and AGENT ownership (affinity map `terminalAgentAffinity`). `getTabTerminalSession` consulted affinity first, so a user's explicit pick was swallowed whenever an affinity entry existed, and agent bind/adopt wrote the field directly — clobbering user state and poisoning it with ad-hoc pool anchors.

## What changed

- `getTabTerminalSession` — user-preference-first: `state.terminalSessionId` ('auto' returned as-is; live id honored; dead id cleared then falls through) → active-session affinity → any live affinity → undefined.
- New `getOwnedTerminalSession(tabId)` — ownership oracle reading ONLY the affinity map (active-session-first). Never reads `state.terminalSessionId`, never consults `sessionTabPools` (pool-only members are not owners; gate parity with `isTerminalAllowedForTab`).
- Ownership consumers rewired to the oracle: `terminalWrite` default, isAgent KILL/RESTART/RESIZE/split-session paths (each now also `assertTerminalAccess`-gated — previously unguarded latent bug), bridge `terminalWriteForAttachment` (now gates on `isTerminalAllowedForTab` directly), bridge `initActiveTerminalSessionId` (intersected with allowed list).
- `claimTabTerminalSession` — single write path for agent claims: refuses non-live ids and splitOf sessions (via `getSession`, not `listSessions` — the latter crashes on bufferless stub sessions), never overwrites 'auto' or a live different choice.
- `bindTerminalAgentAffinity` — now calls `dropTerminalAffinityEntries` (map keys + pool only) instead of `clearTerminalAgentAffinity`, so rebinds no longer wipe user picks on unmanaged tabs. `clearTerminalAgentAffinity` retains the field wipe for session-closed/delete paths.
- `removeManagedTab` — deletes lineage; deletes the entry outright when `managedTabIds` empties (tombstone reserved for tab-close).
- `adoptChildTab` — revives tombstoned entries; honest `false` for terminalId-without-entry (tab-anchored ad-hoc pools still true); parent-terminal resolution scans the affinity map for a live entry claiming the parent instead of trusting the preference field.
- Renderer: sleeping-session badge shows 💤 and the click becomes the wake gesture (`wakeSleepingSession`); picker item clicks `focusTab` (new preload wrapper → `antifan:toolbar:switch-tab`); popover rebuild guarded by `data-managed-sig` (tabs broadcasts no longer eat clicks) plus a post-await display re-check (dismissed popover can't re-open); `renderedManagedCount` TDZ fixed.

## Verification

- Scoped suites: 86 tests (affinity 36 incl. new 24–30, per-tab-session, comprehensive-30-flow, phase-02-agent-plane-authority, bridge-terminal-affinity) — 85 pass, 0 fail, 1 skip.
- Renderer harness: 92/92 pass.
- `test:unit`: 1098 pass / 0 fail. `test:main`: 1286 pass / 5 fail — all proven foreign (sibling session's mcp-dispatch-accounting work) or parallel-load flake; none in touched files.
- Code review: PASS on all 9 acceptance criteria; one low-severity race (popover re-open after dismiss during IPC) fixed in-flight.
- Kongming advisory: conditional GO; three flagged defects (oracle/gate divergence, clear-wipes-picks, stale-field adoption) all fixed and covered by new tests 29–30.

## Known residual risks

- `test:main` full-suite flake: `bridge-pairing-queue-concurrency` times out under parallel load (Windows icacls slowness); passes in isolation.
- `reviveTerminalAgentAffinity` writes `state.terminalSessionId` directly (guarded by `!field`, cannot clobber) — bypasses `claimTabTerminalSession`'s live-session validation; informational only.
- Picker rebuild signature omits tab titles — same-count tab swap leaves stale rows until next sig change; cosmetic.

## Commit status

NOT committed — working tree contains another session's in-flight work (plan `260917-0341-mcp-dispatch-accounting`: untracked `mcp-dispatch-service.ts`, `invocation-frame-checksum.ts`, modified `invocation-ledger.ts`, `tab-devtools-host.ts`, `toolbar-preload.ts`, `tree-walker-sanitizer.ts`, `browser-capabilities.ts`, `scripts/materialize-surface.cjs`, `packages/site-clone`, `scripts/antifan-omp-mcp.cjs`). `npm run compile` currently fails on those foreign files only. Commit requires staging our six files selectively once the sibling work settles.
