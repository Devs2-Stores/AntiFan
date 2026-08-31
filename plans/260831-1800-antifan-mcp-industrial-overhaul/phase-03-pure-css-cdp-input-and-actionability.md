---
phase: 3
title: "Pure CSS-Pixel CDP Input & Actionability Gate"
status: pending
priority: P0
effort: "3.5h"
dependencies: [1, 2]
---

# Phase 03: Pure CSS-Pixel CDP Input & Actionability Gate

## Overview
Replaces fragile synthetic DOM dispatching (`dispatchEvent`) with hardware-level CDP native input (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`). Leverages `getTabWebContents(tabId, paneId)` to target the exact pane's WebContents, calculates element center coordinates in pure in-page CSS pixels (zero DPR multiplier or window offset errors), executes an in-page `MutationObserver` actionability check (1.5s timeout), and falls back seamlessly to Isolated World synthetic events if `wc.debugger` is held by manual user DevTools.

## Requirements
- **Functional:**
  - `anti.agent.cursor.click`, `anti.agent.cursor.type`, `anti.agent.cursor.hover` fire authentic browser-level CDP input events with `event.isTrusted === true`.
  - Input coordinates are derived from `element.getBoundingClientRect()` in pure CSS pixels relative to the targeted `WebContents` viewport.
  - In-page actionability pre-flight checks:
    * `isConnected === true` (Element attached to DOM).
    * `getComputedStyle().display !== 'none'` and `visibility !== 'hidden'` and `opacity > 0`.
    * `element.disabled !== true` (For form inputs / buttons).
    * Bounded polling timeout: maximum 1500ms using `MutationObserver` or `requestAnimationFrame`.
  - Debugger contention handling: If `wc.debugger.attach()` fails because the user opened F12 Chrome DevTools on the Electron tab, log a warning and fall back to the existing Isolated World Synthetic cascade (`isTrusted: false`) without crashing.
  - Visual Agent Cursor overlay stays synchronized with the calculated target center coordinate.
- **Non-functional:**
  - Zero IPC storm: Actionability check runs entirely inside the tab renderer; zero polling round-trips over WebSocket.
  - Full compatibility with React 16–19, Vue 3, Shopify Hydrogen, and Haravan storefront frameworks.

## Architecture
```
[User / Agent calls anti.agent.cursor.click]
                     │
                     ▼
[TabAutomationHost.dispatchAgentAction]
                     │
                     ▼
[getTabWebContents(tabId, paneId)] -> Exact Pane's WebContents
                     │
                     ▼
[In-Page Actionability Pre-flight (World 1004)]
  - MutationObserver wait for visible/attached (max 1.5s)
  - Returns CSS Center (x, y) = { left + width/2, top + height/2 }
                     │
                     ▼
             [wc.debugger Check]
            /                   \
(Available / Attached)    (Busy / Held by F12)
          ▼                         ▼
[CDP Input.dispatchMouseEvent]   [Synthetic Isolated World Dispatch]
(mousePressed -> mouseReleased)  (dispatchEvent fallback + Log Warning)
(isTrusted: true)                (isTrusted: false)
          │                         │
          └────────────┬────────────┘
                       ▼
    [Update Visual Agent Cursor & Return Result]
```

## Related Code Files
- Modify: `src/main/browser/tab-automation-host.ts` (Implement CDP input dispatching, in-page actionability script, debugger attachment check & fallback).
- Modify: `src/main/browser/semantic-ref-executor.ts` (Update executor script to support actionability resolution and return center CSS coordinates).
- Create: `test/main/cdp-native-input-actionability.test.ts` (Live test validating CDP trusted events, CSS pixel coordinate precision, actionability wait, and fallback).

## Implementation Steps
1. **In-Page Actionability & Coordinate Resolution:**
   - In `src/main/browser/semantic-ref-executor.ts`, add `resolveElementCenterAndActionability` helper.
   - Use `MutationObserver` (with 1500ms deadline) to wait until selector/ref matches an element that is attached, visible (`offsetWidth > 0 && offsetHeight > 0`), and not disabled.
   - Return `{ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }`.
2. **CDP Input Dispatcher with Graceful Fallback:**
   - In `src/main/browser/tab-automation-host.ts`, implement `dispatchCdpMouseEvent(wc, type, x, y, options)`.
   - Check `if (!wc.debugger.isAttached()) { try { wc.debugger.attach('1.3'); } catch (err) { /* fallback */ } }`.
   - Dispatch `Input.dispatchMouseEvent` with `{ type: 'mousePressed', x, y, button: 'left', clickCount: 1 }` followed by `mouseReleased`.
   - For typing: dispatch `Input.dispatchKeyEvent` with `{ type: 'keyDown'/'keyUp', text }` and `Input.insertText`.
   - If debugger attach fails (e.g. F12 open), fall back to `executeInIsolatedWorld` synthetic event cascade with warning `[tab-automation-host] wc.debugger busy, using synthetic input fallback`.
3. **Cursor Overlay Synchronization:**
   - Update `__antifan_agent_cursor__` overlay to render at $(x, y)$ smoothly via CSS transition.
4. **Unit & E2E Verification:**
   - Verify on a test page that `event.isTrusted === true` when CDP is active.
   - Verify that element appearing after 300ms delay is successfully clicked by actionability gate.

## Success Criteria
- [ ] Mouse clicks and keyboard typing trigger authentic `isTrusted: true` events.
- [ ] Coordinates align precisely without DPR or window offset drift.
- [ ] Dynamic elements (rendered after 200-500ms delay) resolve without `Element not found` errors.
- [ ] Opening DevTools F12 triggers graceful synthetic fallback without throwing fatal exceptions.

## Risk Assessment
- **Risk:** WebContents destroyed while CDP debugger command is pending.
- **Mitigation:** Wrap CDP calls in `try/catch` and verify `!wc.isDestroyed()` before every debugger send.
