# Antigravity Browser Desktop — Operations

Install, update, logs, rollback, and process ownership for the opt-in desktop
companion. The current Extension browser remains the independent fallback at
every step.

## Install / upgrade

- Windows x64 installer; user data lives in the per-profile app-data dir.
- Version compatibility is enforced before any side effect: a mismatch returns
  a clear compatibility error and the old Extension browser stays usable.
- Pre-upgrade copies of schemas, profiles, pending handoffs, and delivery
  records are preserved (immutable) so a newer reader never mutates an
  unreadable record, and a rolling downgrade can recover the original bytes.

## Logs export

- Diagnostics export is REDACTED by default: secrets, cookies, authorization,
  and page bodies are stripped (`redactStringValues` + sensitive-key redaction).
- Never export raw page HTML, console bodies, or network response bodies.

## Uninstall / rollback

- Uninstall does NOT delete user browser profiles unless explicitly selected.
- Rollback requires no workspace data migration: stop the desktop app and
  disconnect the bridge; existing commands, iframe browser, captures, MCP
  resources, Queue, and the currently supported Chat behavior continue on the
  current Extension path.
- Disable desktop integration = disconnect the app; nothing auto-removes the
  iframe browser.

## Process ownership

- Single-instance lock prevents duplicate services; `before-quit` disposes the
  tab host and controller. Extension deactivation and app exit leave no orphan
  Electron processes or ports.
- Cleanup: close the desktop app first (SIGTERM/taskkill by PID), never match a
  broad `pkill` that could catch unrelated processes.

## Desktop becomes preferred — only after explicit acceptance

- Desktop integration is opt-in. Run `antigravityBrowser.desktopStatus` for a
  status that always reports queued-not-submitted and never claims auto-send.
- Desktop is considered the preferred entrypoint ONLY after a documented
  user-acceptance cycle, never automatically.