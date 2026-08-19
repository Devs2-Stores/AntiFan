# Fix Production Review Findings

## Outcome

Repair the confirmed bridge, session, toolbar, tab, Quick Add, magnifier, and
artifact-retention defects without changing the public toolbar IPC envelope.

## Constraints

- Preserve the existing Chrome-like desktop UI language.
- Keep remote pages sandboxed and without preload access.
- Do not run Haravan CLI or change deployment behavior.
- Keep login state through Chromium persistence; never persist broad plaintext
  cookie exports.
- Write each annotation to one project-scoped root with an app-data fallback.

## Non-goals

- Wire the latent MCP or plugin runtimes.
- Add a general password manager or credential vault.
- Redesign the browser shell.

## Phases

1. Harden bridge pairing, compatibility, delivery dedupe, and pipe bounds.
2. Replace plaintext cookie export with encrypted storefront-access persistence.
3. Bind browser operations to stable tab/view ownership and fix navigation policy.
4. Repair toolbar, tab-strip, console, and magnifier behavior.
5. Unify artifact persistence, byte budgets, and cleanup filename contracts.
6. Add regression coverage and run typecheck, tests, build, audit, and focused UI checks.

## Acceptance Criteria

- Unapproved, incompatible, expired, oversized, and duplicate bridge requests fail closed.
- No broad `cookies.json` is created; a legacy file is migrated safely and removed.
- Haravan storefront access cookies can survive restart when OS encryption is available.
- Lens Zoom paints, Console is visible, and toolbar/tab controls remain reachable at 375px.
- Quick Add cancels if its source tab or document changes.
- One annotation creates one artifact set; every managed filename is TTL/max-count cleaned.
- Static IPC/listener contracts, typecheck, full unit suite, build, and dependency audit pass.

## Risks And Rollback

- Older bridge peers missing bundle/deadline fields will be rejected; rollback is limited to
  the bridge hardening files and matching tests.
- Cookie migration deletes the legacy plaintext file only after selected access cookies are
  restored and Chromium storage is flushed.
- UI changes stay within renderer layout and existing host docking APIs.
