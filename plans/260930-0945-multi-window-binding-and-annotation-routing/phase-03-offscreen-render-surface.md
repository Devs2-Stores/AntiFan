---
title: "Phase 3: Offscreen render surface"
status: done
---

# Phase 3: Offscreen render surface

## Overview

Offscreen (OSR) agent tabs are minted (`createTab` :8299-8304,
`webPreferences.offscreen:true` via security-policy.ts:147-149) but **never sized**:
`updateLayout` skips offscreen tabs (:1926-1930) and nothing calls `setBounds` or
`applyTabDeviceEmulation` at mint → 0x0 surface → OSR BeginFrame source never ticks →
rAF stalls → `capturePage`/CDP `Page.captureScreenshot` burn the full bound →
`capture.raster` timeout with 'compositor produced no frame'. The repo's own probe
recipes always size OSR views immediately.

Research (Electron 43.4.0, Chromium 150): `webContents.setSize` does not exist; detached
`setBounds` alone does not produce layout (measured in-repo). OSR `RenderWidgetHostView`
owns its own compositor → `Emulation.setDeviceMetricsOverride` on an OSR webContents
yields layout + raster surface WITHOUT attach — feasible via
`wc.debugger.sendCommand(...)` (per-WebContents, no view attach; red-team verified).

Critical edge: `runWithAttachedTabView` (native-tab-host.ts:5764-5800) attaches ANY
unattached view → `AddChildView`→`SetOwnerWindow`, owner NEVER cleared on detach → OSR
raster size is rewritten to the project window size on every resize (Electron #45864).
`setViewportSize` background branch routes through it. No offscreen→onscreen promote
path exists, so a never-attach guard breaks nothing.

## Requirements

- [ ] **Spike first (kongming condition):** repo Electron 43.4 — detached
      `WebContentsView({offscreen:true})` never attached +
      `wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride')` →
      `Page.captureScreenshot{fromSurface:true}` / `capturePage` returns non-empty
      raster. If no: pivot to fixed-size hidden capture-host window fallback.
- [ ] `createTab` offscreen branch (~:8366, after `indexTabWebContents`): apply
      `applyTabDeviceEmulation` (def :10523) with customViewport → window content box →
      named default agent viewport fallback; re-apply via `pendingEmulationDeferrals`
      (field :1617, use :10892) / `ensureTabReady` (def :9807) on renderer swap/crash.
- [ ] OSR never-attach guard INSIDE `runWithAttachedTabView` keyed on resolved
      `tab.state.offscreen` (covers all callers incl. sweepBreakpoints ~:13972) — run
      the action without `attachTabView`.
- [ ] `setViewportSize` OSR branch: bypass BOTH the window content-bounds measurement
      (:14148-14184 throws VIEWPORT_NOT_APPLIED when the window can't report a box —
      irrelevant for OSR) AND the attach — `applyTabDeviceEmulation(tab, w, h, 0)`
      directly (customViewport carries requested dims); keep VIEWPORT_NOT_APPLIED only
      for attached-background tabs.
- [ ] Capture path (tab-devtools-host.ts ~:1778, ~:2208 `assertCaptureSurfacePresent`):
      offscreen target + empty/timeout native raster → typed error; never fall to CDP
      `fromSurface` (stall/crash class on OSR).
- [ ] Do NOT 'fix' `paintWhenInitiallyHidden:false` — no-op on WebContentsView; do NOT
      add `show:false` (sets `initially_hidden`, breaks OSR painting).

## Related Code Files

- Modify: `src/main/browser/native-tab-host.ts` (createTab offscreen branch ~:8366,
  runWithAttachedTabView :5764, setViewportSize :14123-14215, applyTabDeviceEmulation
  :10523, ensureTabReady :9807, pendingEmulationDeferrals :1617/:10892)
- Modify: `src/main/browser/tab-devtools-host.ts` (capture tiers ~:1769-1790, :2208)
- Optional: `src/main/tools/browser-control-port.ts` (:2344-2346 OSR error hint)
- Read: `src/main/security/security-policy.ts` (:147-149); probes
  `scripts/probe-detached-capture-surface.cjs`, `probe-occluded-capture.cjs`,
  `probe-background-full-page.cjs`

## Test Coverage

- Create `test/unit/native-tab-host-offscreen-surface.test.ts` (no
  `test/main/native-tab-host.test.ts` exists; nearest is
  `test/unit/native-tab-host-viewport.test.ts`): mint offscreen applies emulation;
  runWithAttachedTabView does NOT attach OSR views; setViewportSize OSR direct path.
- `test/main/render-surface-and-viewport-gates.test.ts`: offscreen tab reaches non-zero
  layout viewport.
- `test/main/tab-devtools-host.test.ts`: OSR capture empty → typed error, no CDP fallback.
- Electron probe run: `probe-occluded-capture.cjs` cases + fresh-mint capture proof.

## Success Criteria

Fresh offscreen tab without `set_viewport`: `innerWidth>0`, frame liveness probe resolves
(<300ms), raster returns within bound; `capture.raster` journal shows no 'timeout'.

## Risks / Rollback

- OSR raster mechanism is a strong inference until the spike lands — spike is the gate.
- One attach of an OSR view poisons its size permanently — the never-attach guard is
  load-bearing; place it inside `runWithAttachedTabView`, not at call sites.
- Revert = remove mint emulation + guard; no persisted state.
