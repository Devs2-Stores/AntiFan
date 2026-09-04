---
phase: 1
title: "Core Corrections & CDP Primitives"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Core Corrections & CDP Primitives

## Overview
Address two foundational lower-level gaps in AntiFan's engine:
1. Fix the viewport emulation regression in `NativeTabHost.setViewportSize` where non-preset dimensions silently fall back to disabling device emulation (`safeDisableDeviceEmulation`).
2. Expose the native Chromium CDP `CSS.getMatchedStylesForNode` gateway through `TabDevToolsHost` and `BrowserHostPort` to supply raw cascade evidence without brittle DOM JavaScript scraping.

## Requirements
- **Functional Requirements:**
  - `NativeTabHost.setViewportSize` must synthesize an ad-hoc `DevicePreset` when custom `width` and `height` are provided, preserving device scale factor, mobile flag, and touch emulation via `safeEnableDeviceEmulation`.
  - `TabDevToolsHost` must provide `getMatchedStylesForNode(webContents, nodeId)` via CDP `CSS.getMatchedStylesForNode`.
  - `BrowserHostPort` and `BrowserControlPort` must expose `getMatchedStylesForNode(tabId, nodeId)` returning structured CDP matched rules.
  - Register atomic capability `browser.get-matched-styles` in `browser-capabilities.ts` with schema validation and error handling.
- **Non-Functional Requirements:**
  - Zero disruption to existing named presets in `src/main/browser/device-presets.ts`.
  - Fail-safe fallback if CDP session is detached or node is not present in DOM tree.

## Architecture
```text
Browser Action / OMP Tool Call
        v
browser-capabilities: browser.get-matched-styles
        v
BrowserControlPort / BrowserHostPort
        v
TabDevToolsHost.getMatchedStylesForNode(webContents, nodeId)
        v
CDP Session: CSS.getMatchedStylesForNode
        v
Protocol.CSS.GetMatchedStylesForNodeResponse
```

## Related Code Files
- Modify: `src/main/browser/native-tab-host.ts` (fix `setViewportSize` dynamic preset synthesis)
- Modify: `src/main/browser/tab-devtools-host.ts` (implement `getMatchedStylesForNode`)
- Modify: `src/main/tools/browser-control-port.ts` (expose method on `BrowserHostPort` and `BrowserControlPort`)
- Modify: `src/main/tools/browser-capabilities.ts` (register `browser.get-matched-styles` capability)
- Test: `test/native-tab-host-viewport.test.ts` (viewport emulation regression unit test)

## Implementation Steps
1. **Fix `setViewportSize` in `native-tab-host.ts`:**
   - Inspect lines 5298–5330.
   - When `preset` is null but `options.width` and `options.height` are valid numbers $> 0$:
     - Construct `dynamicPreset`: `{ id: 'custom', name: 'Custom Viewport', width, height, deviceScaleFactor, mobile, touch }`.
     - Call `this.safeEnableDeviceEmulation(tab, dynamicPreset)`.
     - Update tab metadata (`tab.viewportWidth`, `tab.viewportHeight`, `tab.selectedDeviceId`).
2. **Implement CDP Matched Styles in `tab-devtools-host.ts`:**
   - Add method `public async getMatchedStylesForNode(webContents: Electron.WebContents, nodeId: number): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse | null>`.
   - Ensure `CSS` domain is enabled via `this.ensureDomainEnabled(webContents, 'CSS')`.
   - Send `CSS.getMatchedStylesForNode({ nodeId })` with error handling.
3. **Bridge via `browser-control-port.ts`:**
   - Add `getMatchedStylesForNode(tabId: string, nodeId: number): Promise<unknown>` to `BrowserHostPort`.
   - Implement resolution in `BrowserControlPort` using tab webContents and `TabDevToolsHost`.
4. **Register `browser.get-matched-styles` capability:**
   - In `src/main/tools/browser-capabilities.ts`, define schema (`tabId`, `nodeId` or `ref`), handler, and register with `capabilityCatalogue`.

## Success Criteria
- [x] `native-tab-host.ts` correctly activates `safeEnableDeviceEmulation` for arbitrary width/height pairs (e.g. 320x568, 768x1024).
- [x] Direct test verifies that `getMatchedStylesForNode` returns matched CSS rules with rule selectors, declarations, and stylesheet IDs.
- [x] Low-level capability `browser.get-matched-styles` is discoverable in capability catalogue.

## Risk Assessment
- *Risk:* Calling `CSS.getMatchedStylesForNode` before `DOM.enable` or `CSS.enable` causes CDP protocol errors.
  *Mitigation:* `TabDevToolsHost` must idempotently invoke `ensureDomainEnabled` for both `DOM` and `CSS` domains before querying node styles.
