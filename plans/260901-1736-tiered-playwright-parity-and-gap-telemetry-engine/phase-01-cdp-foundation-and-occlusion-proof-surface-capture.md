---
phase: 1
title: "CDP Foundation & Occlusion-Proof Surface Capture"
status: in-progress
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: CDP Foundation & Occlusion-Proof Surface Capture

## Overview
Establish a robust, fault-tolerant Chrome DevTools Protocol (CDP 1.3) client foundation inside `TabDevToolsHost` and `NativeTabHost`, integrating an occlusion-proof viewport capture engine that completely eliminates `TIMEOUT: browser.screenshot` when AntiFan Desktop is minimized, backgrounded, or occluded by other OS windows.

## Requirements
- **Functional:**
  - Attach Electron `webContents.debugger` on-demand with lazy initialization, single-client command queue mutex, and auto-recovery on unexpected detach.
  - Enable core CDP domains (`Page`, `DOM`, `Runtime`, `Network`) and handle domain command multiplexing safely.
  - Upgrade `captureScreenshot` with dual-tier capture: fast `webContents.capturePage()` with immediate fallback to CDP `Page.captureScreenshot({ fromSurface: false, captureBeyondViewport: true })`.
  - Implement dynamic frame unthrottling (`RT-02` via temporary `wc.setBackgroundThrottling(false)` and compositor tick pump) to force Chromium compositor repaint on occluded/background tabs before capture without relying on non-existent CDP scheduling methods.
- **Non-functional:**
  - Viewport screenshot latency < 300ms on background tabs.
  - 0% unhandled promise hangs or debugger contention deadlocks.
  - Zero memory leaks across rapid tab open/close cycles.

## Architecture
```mermaid
graph TD
    A[anti.screenshot.viewport Request] --> B[TabDevToolsHost]
    B --> C{webContents.isDestroyed()?}
    C -->|Yes| D[Throw TARGET_STALE]
    C -->|No| E[Trigger RT-02 Unthrottle: wc.setBackgroundThrottling false]
    E --> F[Tier 1: webContents.capturePage with 500ms race]
    F -->|Success| G[Encode PNG base64]
    F -->|Timeout / Empty Buffer| H[Tier 2: CDP Page.captureScreenshot fromSurface: false]
    H -->|Success| G
    H -->|Error / Timeout| I[Return descriptive CAPABILITY_ERROR]
    G --> J[Re-apply RT-02 Background Throttling if idle]
    J --> K[Return Encoded Viewport Payload]
```

## Related Code Files
- Modify: `src/main/browser/tab-devtools-host.ts` (CDP session client, auto-reattach, command mutex, dual-tier capture)
- Modify: `src/main/browser/native-tab-host.ts` (Integrate CDP host lifecycle with Tab lifecycle)
- Modify: `src/main/tools/browser-capabilities.ts` (Capability definitions for screenshot and CDP transport)

## Implementation Steps
1. Refactor `TabDevToolsHost` to implement `CdpSessionClient` interface with safe `attach()`, `detach()`, `sendCommand()`, and `setupAutoReattach()`.
2. Add a command FIFO queue/mutex in `TabDevToolsHost` to serialize concurrent CDP requests and prevent `Debugger is already attached` / `Detached from target` races.
3. Enhance `captureScreenshot` method:
   - Temporarily unthrottle background tab via `wc.setBackgroundThrottling(false)`.
   - Issue fast `wc.capturePage()` with 500ms timeout race.
   - If empty or stalled, fall back immediately to CDP `Page.captureScreenshot({ fromSurface: false, captureBeyondViewport: true })`.
   - Re-throttle tab state upon completion if tab is not currently executing active automation actions.
4. Update `NativeTabHost` to wire `TabDevToolsHost` during tab creation and guarantee clean debugger detachment on tab close.
5. Add unit and integration tests verifying screenshot capture against backgrounded and occluded web contents.

## Success Criteria
- [ ] `TabDevToolsHost.sendCommand` successfully issues CDP commands across all enabled domains.
- [ ] `captureScreenshot` produces valid non-empty PNG buffer when window is minimized or occluded in < 300ms.
- [ ] Debugger disconnects cleanly when tab closes without leaving dangling listeners.
- [ ] 0 TypeScript compiler errors.

## Risk Assessment
- **Risk:** User manually opens Chrome DevTools window, detaching the automated debugger session.
- **Mitigation:** Listen to `webContents.debugger.on('detach')`, set `debuggerAttached = false`, fallback gracefully to `executeJavaScript`, and re-attach automatically when DevTools window closes without thrashing loops.
