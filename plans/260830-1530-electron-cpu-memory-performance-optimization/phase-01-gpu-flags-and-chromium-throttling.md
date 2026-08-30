---
phase: 1
title: "Chromium GPU Negotiation & Render Throttling Tuning"
status: pending
priority: P1
effort: "45m"
dependencies: []
---

# Phase 01: Chromium GPU Negotiation & Render Throttling Tuning

## Overview
Removes hazardous Chromium GPU override switches that bypass driver stability lists and cause D3D11/ANGLE busy-wait spinlocks on Intel UHD 630 Graphics. Configures aggressive background renderer throttling to prevent background tabs and hidden webviews from consuming CPU cycles.

## Requirements
- Functional:
  - GPU hardware acceleration must remain active for window compositing, video playback, and CSS transforms.
  - Software SwiftShader fallback must NOT be triggered.
  - Background tabs and hidden WebContentsViews must throttle timers and animation frames when inactive.
- Non-functional:
  - GPU process (`--type=gpu-process`) CPU usage at idle must drop from 130% to < 2%.

## Architecture & Code Changes

### Target: `src/main/index.ts`
1. Remove toxic GPU command-line switches:
   - Remove `app.commandLine.appendSwitch('ignore-gpu-blocklist')`
   - Remove `app.commandLine.appendSwitch('enable-gpu-rasterization')`
   - Remove `CanvasOopRasterization` from `--enable-features`
2. Add background throttling switches:
   - `app.commandLine.appendSwitch('disable-background-timer-throttling', 'false')`
   - `app.commandLine.appendSwitch('disable-renderer-backgrounding', 'false')`
3. Retain safe performance features:
   - `enable-smooth-scrolling`
   - `enable-accelerated-video-decode`
   - `enable-quic`
   - `enable-fast-unload`
   - `enable-tcp-fast-open`
   - `enable-features: PasswordManager,Autofill,SmoothScrolling,ParallelDownloading,BackForwardCache,AsyncImageDecoding`

### Target: `src/main/security/security-policy.ts`
Ensure `getSecureWebPreferences()` enforces:
- `backgroundThrottling: true` (already configured, verified)

## Related Code Files
- Modify: `src/main/index.ts`
- Verify: `src/main/security/security-policy.ts`

## Implementation Steps
1. Edit `src/main/index.ts` to remove `ignore-gpu-blocklist`, `enable-gpu-rasterization`, and `CanvasOopRasterization`.
2. Add background timer throttling and backgrounding switches.
3. Run `npm run compile` to verify TypeScript builds cleanly.

## Success Criteria
- [ ] TypeScript compilation passes with zero errors (`npm run compile`).
- [ ] GPU process starts without `--ignore-gpu-blocklist`.
- [ ] Chromium internal GPU diagnostics (`chrome://gpu` / `app.getGPUFeatureStatus()`) report Hardware Accelerated for Compositing and Video.
- [ ] GPU Process CPU at idle stays below 3%.

## Risk Assessment
- *Risk:* WebGL performance might degrade on legacy canvas benchmarks.
- *Mitigation:* Verified in KongMing audit: Intel UHD 630 native D3D11 compositor handles canvas adequately without OOP raster spinlock.
