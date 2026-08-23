# Standalone Control Plane Release Gate

## Evidence

- `npm run typecheck`: pass.
- `npm run compile`: pass.
- Desktop focused and integration tests: 48 pass, 0 fail, 0 cancelled.
- Antigravity companion tests: 110 pass, 0 fail, 0 cancelled.
- `ak plan validate plans/260820-1301-build-antifan-standalone-control-plane --json`: valid.
- `ak plan status ... --json`: 9/9 phases, 47/47 checkboxes complete.

## Delivered boundaries

- Project/Workspace/Chat/Run/Attempt IDs are explicit and lineage checks reject cross-owner requests.
- Lease-authenticated, policy-aware capability catalogue supports browser/file/terminal seams and transport adapters; read is default, write/execute/eval require grants.
- Browser actions require an explicit runtime/tab/epoch/document target; active-tab behavior remains legacy-only.
- Event/receipt stores use versioned append-only records, exact binding reconciliation, bounded artifacts, and restart interruption recovery.
- Codex and Antigravity are backend adapters; DeepSeek Harness remains feature-gated research compatibility.
- Theme QA inspect/edit/reload/evidence workflow is covered without a renderer rewrite.

## Known release limitations

- The existing Electron renderer still owns the legacy UI surface; the future Project renderer plan remains the presentation owner.
- Codex CLI availability and Windows PTY behavior require target-machine smoke validation when packaging a release build.
- Legacy MCP/bridge calls remain compatible when no standalone lease envelope is supplied; standalone callers must use the catalogue envelope.
