---
title: Implement Split Web Desktop Mobile Review
date: 2026-08-25
summary: "Add dual live WebContentsViews review mode with loop-guarded synchronization, race-safe history traversal barrier, and focused-pane tool routing."
---

# Implement Split Web Desktop Mobile Review

## Summary
Implemented a live, same-session Desktop + Mobile WebContentsView split review mode in `antifan-browser-desktop`.

## Key Decisions & Architecture
1. **Dual Native Views in Common Tab Session**:
   - One logical `AntiFanTab` coordinates two live `WebContentsView`s (`desktop` and `mobile`).
   - Both panes share cookies, localStorage, and capsule subscriptions without partition separation.
   - DOM, form inputs, scroll position, focus, and device emulation parameters remain strictly independent.

2. **Loop-Guarded Navigation & History Traversal Barrier**:
   - `SplitNavigationCoordinator` enforces single-transaction authority with echo-loop suppression on `did-navigate` and `did-navigate-in-page`.
   - History traversal (`goBack`/`goForward`) initiates on authority view. Pre-authority organic sibling navigations cleanly supersede/cancel the history transaction and establish a new organic transaction.
   - A per-tab `staleHistoryDiscards` barrier swallows delayed commits from abandoned history traversals while distinguishing legitimate target mirror commits, guaranteeing order-independence regardless of whether the mirror commit or stale history commit arrives first.

3. **Focused Pane Targeting & MCP Capabilities**:
   - Added focused pane switching and viewport coordinate conversion (`convertToPaneCoordinates`).
   - MCP tools (`agentSnapshot`, `agentClick`, `evalJs`, `inspect`) route to the focused pane or explicit target pane.

4. **Persistence & Security**:
   - Durable tab persistence retains split mode and preset IDs while omitting transient runtime focus and DOM state.
   - Security scheme sanitization blocks `javascript:` and dangerous URI schemes across both views.

## Verification Evidence
- `npm run typecheck`: 0 errors.
- Unit test suite (`npm test`): 47 suites, 186 unit tests passed (including order-1 and order-2 history supersede regression tests).
- Real Electron smoke test (`npm run smoke:split`): 8/8 real Electron GUI steps passed end-to-end with clean exit code 0.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
