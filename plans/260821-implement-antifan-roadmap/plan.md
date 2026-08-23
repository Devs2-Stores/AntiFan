# AntiFan Roadmap Implementation

## Outcome

Deliver a stable, workspace-scoped AntiFan desktop runtime with recoverable Chromium startup, a durable Workspace Capsule, a bounded lightweight editor, and no production dependency on the retired Antigravity IDE delivery/sidebar bridge.

## Constraints

- Preserve existing user changes and current AntiFan WebSocket BridgeServer, MCP server, browser control plane, cookies, and automation capabilities.
- Keep the main process as the authority for profiles, filesystem access, terminals, and browser state.
- Never delete the Chromium profile or cookies automatically.
- Editor file operations must remain inside the active capsule workspace and reject traversal, absolute paths, symlinks, and reparse boundaries.
- Use the existing backup at `plans/backups/legacy-antigravity-bridge-20260820-235249` and create a current manifest before destructive legacy bridge removal.
- Do not start deployment or Haravan CLI.

## Non-goals

- No Git UI, debugger, extension marketplace, model router, or full IDE replacement.
- No removal of current WebSocket/MCP/browser automation code.
- No silent profile reset or cookie migration.

## Acceptance criteria

- A deterministic per-mode profile lease prevents two GUI AntiFan instances from sharing the same Chromium profile; a second launch focuses the owner.
- Unclean shutdown is detected and recovery state is durable; safe start can avoid eager restoration of risky tabs.
- Renderer crashes mark/recover the affected tab without exiting the app.
- A Workspace Capsule persists workspace path, browser tabs, terminal/split metadata, selected profile, UI zoom/sidebar/device state, and editor state.
- Capsule switching updates the browser/terminal/editor projections together and split ratios remain scoped to capsule and terminal tab.
- Legacy Antigravity delivery/sidebar production references are removed after backup while BridgeServer/MCP/browser control remain functional.
- Editor supports workspace file tree, multiple file tabs, syntax-aware editing, dirty state, Ctrl+S, in-file search, and atomic safe writes.
- `npm run typecheck`, `npm test`, `npm run compile`, and `npm run verify` pass.

## Phases

1. Add deterministic profile ownership/recovery primitives and tests.
2. Add Workspace Capsule persistence/switching authority and tests.
3. Back up and remove legacy Antigravity delivery/sidebar wiring; preserve live bridge contracts.
4. Add bounded editor IPC/state/UI and tests.
5. Integrate projections, update docs, run full validation, and record rollback notes.

## Risks

- NativeTabHost currently mixes legacy and standalone IPC; deletion must be incremental so it never becomes uncompilable.
- Existing terminal persistence is global; capsule integration needs a compatibility path until all callers use capsule scope.
- Electron runtime behavior cannot be fully proven by TypeScript tests alone; Windows smoke testing remains a release follow-up.

## Validation

Run focused unit tests after each phase, then `npm run typecheck`, `npm test`, `npm run compile`, and `npm run verify`. Inspect `git diff --check` and verify no production imports remain for retired bridge modules.

## Rollback

Restore the current manifest backup and revert only the roadmap files if a phase fails. Keep Chromium profile data untouched; disable capsule/editor integration behind the existing main-process wiring rather than deleting user state.
