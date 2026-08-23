# Chromium Performance Research: AntiFan and Orca Patterns

Timestamp: 2026-08-20 23:00 Asia/Ho_Chi_Minh

## Executive Summary

AntiFan's main slowdown was local startup and navigation overhead, not a missing Chromium speed flag. The strongest verified issue was inactive tab restore: each restored tab was loaded once by `createTab()`, immediately stopped, then loaded again on a timer. Chrome profile import also started during restore and competed for disk/SQLite/Python I/O.

The implementation now lazy-loads inactive restored tabs, defers Chrome profile import, injects the Agent Browser cursor only when an agent action needs it, and scopes header mutation to Google authentication hosts. Normal requests now pass through without header cloning or rewriting. Google auth identity, persistent cookies, MCP, and visual cursor behavior remain intact.

## Scope and Hypotheses

- Goal: reduce AntiFan startup and foreground page-load latency while preserving auth, tabs, MCP, and agent-visible cursor behavior.
- Hypothesis A: duplicate restore loads plus profile/cookie I/O congest startup.
- Hypothesis B: global request mutation and unconditional cursor script evaluation add per-request/per-navigation overhead.
- Kill-test: inspect restore call order, saved-tab state, request interception, and agent injection call sites before editing.
- Boundary: no CDP auto-attach, no profile deletion, no broad Chromium flag changes, and no changes to user data.

## Observed Baseline

From source and local state:

- Electron version: `43.4.0`; Chrome engine version is read from `process.versions.chrome`.
- Dev profile had 2 saved tabs in `appdata/antigravity-browser-desktop/Chromium-dev/saved-tabs.json`.
- Persistent cookie cache contained 82 entries and was restored serially before the first window.
- `restoreTabs()` previously called `createTab(url)` for every tab, then for inactive tabs called `stop()` followed by a delayed `loadURL(url)`.
- `did-finish-load` previously evaluated the complete `AGENT_BROWSER_SCRIPT` and displayed `Page ready` on every navigation.
- `onBeforeSendHeaders` previously cloned and rewrote headers for every HTTP(S) request.
- Existing verification before and after the change: `npm run typecheck` passed; `npm test` passed with 55/55 tests.

## Orca / Onorca Findings

The Orca README describes a harness-oriented desktop architecture: side-by-side CLI agents, terminal splits, browser Design Mode, persistent scrollback, and a CLI that drives the app. This supports separating agent/harness work from the normal browser path and keeping automation features opt-in.

Sources consulted:

- [Orca README](https://raw.githubusercontent.com/stablyai/orca/main/README.md) — feature and architecture signals.
- [Electron `session` API](https://www.electronjs.org/docs/latest/api/session) — request interception and session behavior.
- [Electron `webContents` API](https://www.electronjs.org/docs/latest/api/web-contents) — renderer/background throttling controls.
- [Electron performance tutorial](https://www.electronjs.org/docs/latest/tutorial/performance) — renderer and startup performance guidance.

Important conclusion: Orca's terminal/browser orchestration is useful as a product pattern, but its README does not justify adding more Chromium command-line switches. The applicable lesson is lazy/intent-driven automation and bounded background work.

## Changes Applied

### 1. Lazy inactive-tab restore

`NativeTabHost.restoreTabs()` now creates inactive tabs without loading their URL. The URL is stored in `deferredTabUrls` and loaded when that tab is first activated. The active tab loads once. This removes the `loadURL -> stop -> loadURL` duplicate work and avoids opening all restored pages at once.

### 2. Deferred Chrome profile import

Chrome profile sync is scheduled 1.5 seconds after tab restore instead of starting in the critical first-window path. The selected profile is still retained and imported in the same session.

### 3. Lazy Agent Browser injection

The unconditional post-navigation cursor injection was removed. Existing action methods still call `ensureAgentBrowserInjected()` before click/type/scroll/highlight/move operations, so agent interactions retain the visible cursor without parsing the large script on every human navigation.

### 4. Scoped network identity handling

Only exact Google auth hosts receive Firefox-like auth identity and client-hint stripping. Normal requests now return their original request headers without cloning or rewriting. This preserves the Gmail login workaround while reducing hot-path work and content-negotiation risk.

## Invariant Ledger

Preserves:

- Google auth request identity on `accounts.google.com` and `accounts.youtube.com`.
- Persistent cookies and Chrome profile selection.
- MCP/browser action routing.
- Agent cursor injection before agent-driven interactions.
- User-visible saved tab order and active-tab restoration.

Deliberately changes:

- Inactive restored tabs remain `about:blank` until selected, reducing background work.
- Chrome profile import may complete shortly after the first window appears.

Risks:

- A restored inactive tab will not begin network activity until selected. This is intentional and matches lazy-tab behavior; workflows requiring all tabs to preload should explicitly activate them.
- The 1.5-second profile-sync delay may postpone newly imported Chrome cookies. Existing AntiFan cookie persistence remains available immediately.

## Verification

- `npm run typecheck`: PASS.
- `npm test`: PASS — 55 tests, 55 pass.
- `git diff --check`: only pre-existing blank-line-at-EOF warnings in `src/renderer/toolbar.html` and `src/renderer/toolbar.ts`.
- Static call-site audit confirms cursor injection remains in the agent action path through `ensureAgentBrowserInjected()`.

## Unresolved Questions

- No controlled cold/warm navigation benchmark was possible without closing or killing the user's many existing Electron instances. A clean before/after benchmark should be run in a dedicated app profile/process window.
- The blanket background-throttling flags remain unchanged. They may be useful for active agent automation but increase CPU/RAM with many tabs; this should be measured per user workload before changing.

## Recommended Next Step

Run one clean benchmark with 1, 3, and 6 saved tabs: time first window visible, active-tab `did-finish-load`, and CPU/RAM after 60 seconds. Use the result to decide whether to make background throttling configurable rather than globally disabled.
