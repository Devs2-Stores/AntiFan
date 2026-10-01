---
title: "Multi-window binding & annotation routing"
description: "Fix cross-project session binding deadlock and annotation misrouting when ≥2 project windows are live; make offscreen agent tabs renderable; add tab-close telemetry."
status: done
priority: P1
effort: "M"
tags: [multi-window, mcp, annotation, offscreen, telemetry]
created: 2026-09-30
---

# Multi-window binding & annotation routing

## Overview

Incident (session `2026-09-30T08-32-29`...`01a0f171`, repo E:\Work\customizes\Whenever):
an agent bound to project Whenever opened its anchor tab inside project Comnieusiba's
window, the tab later died, and every recovery path (`tabs.list`, `rebind_target`,
`browser.evaluate`) returned `UNAUTHENTICATED`/`TARGET_MISMATCH`. Separately, element-picker
annotations are typed into the wrong project's terminal when multiple project windows are
open, because 'auto' routing resolves via the process-global active terminal session.

> **Topology deviation (verified):** "multiple project windows" is unreachable as of
> commit `8ccc3ec4` — per-project windows were retired; `openProject` repoints the
> singleton 'web' hub (`src/main/index.ts:2697-2713`). Phase-06 proves the live
> equivalent: one hub switching A↔B + shared Terminal Manager + two concurrent
> bridge attachments. The incident failure modes (foreign-terminal write, dead-binding
> deadlock) still exist at the session/capsule seam the probe exercises.

Root causes confirmed by source scouting:

1. `dispatchAnnotationToTerminal` (`src/main/browser/annotation-dispatch.ts:25-33`) resolves
   `'auto'`/absent targets via process-global `TerminalManager.getActiveSessionId()`.
2. `antifan.cli.startSession` mints the anchor agent tab on the injected
   `bootstrapHost` with no `capsuleId` (`bridge-server.ts:2478,:2496`, `openTab`
   :2729) — so the BOOT window's host (not the terminal's project window) owns the
   tab, and `resolveNewTabCapsuleId` stamps the bootstrap window's workspace capsule
   (`windowWorkspaceCapsuleId` arm, native-tab-host.ts:8280-8285) → foreign window
   + foreign capsule.
3. `measuredTabAffiliation` (`index.ts:3034`) routes dead ids to `ambientHostOrThrow`
   (:735-742) which throws an untyped `Error` under ≥2 hosts → mapped to
   `UNAUTHENTICATED`/`AUTHENTICATION_DENIED` everywhere, deadlocking recovery.
4. Offscreen (OSR) agent tabs are minted with no bounds/emulation → 0x0 surface →
   OSR BeginFrames never tick → rAF stalls and `capturePage`/CDP capture burn their
   full bound → `capture.raster` timeout.
5. `closeTab` emits no lifecycle event — a vanished agent tab is unattributable.

Kongming go/no-go: GO conditional. Phase ordering P1/P2 (identity) → P3/P4 (surface) →
P5 (telemetry) → P6 (live proof). P1/P2 independent; P3/P4 independent of them but share
`tab-devtools-host.ts`/`native-tab-host.ts` — region-partition or serialize; P5 strictly
after P3/P4; P6 last.

Red-team review: DONE_WITH_CONCERNS → all 12 findings accepted and folded into phase
files, incl. two blockers: `isTabAllowed` control-plane transport seam (:3069 — the
actual rebind_target deadlock gate) added to P1 degrade list with per-seam degrade
values; BridgeServer host-resolution seam added to P2 (anchor was minted on
bootstrapHost = wrong window, not merely wrong capsule).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Dead bound tab never deadlocks MCP: `tabs.list` works, `rebind_target` recoverable | P0 |
| 2 | Agent anchor/child tabs mint into the session's own capsule (project-correct) | P0 |
| 3 | Offscreen agent tabs have a live render surface (rAF + capture work) | P0 |
| 4 | Annotations route to the owning window's terminal; never a foreign project | P0 |
| 5 | Every tab close is journaled with source + capsule/project attribution | P1 |
| 6 | Live two-project proof of all fixes | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Dead-tab affiliation & typed ambient error](./phase-01-dead-tab-affiliation.md) | Done |
| 2 | [Anchor capsule pinning at mint](./phase-02-anchor-capsule-pin.md) | Done |
| 3 | [Offscreen render surface](./phase-03-offscreen-render-surface.md) | Done |
| 4 | [Annotation auto-routing](./phase-04-annotation-auto-routing.md) | Done |
| 5 | [Tab-close telemetry](./phase-05-tab-close-telemetry.md) | Done |
| 6 | [Multi-window live proof](./phase-06-multi-window-live-proof.md) | Done (hub topology, 18+3 live checks, kongming PASS) |

## Success Criteria

- [x] Bound-but-dead tab id: every read seam degrades to `[]`/`false`/`undefined` (never ambient throw); `ambientHostOrThrow` raises `CapabilityError('TARGET_REQUIRED')`; journal line records the degrade.
- [x] `antifan.cli.startSession` + `antifan.openTab` mint tabs carrying the terminal/session capsule; project-claimed session with no resolvable capsule fails closed.
- [x] Fresh offscreen tab (no `set_viewport`): `innerWidth>0`, rAF live, `capturePage`/`anti.screenshot.viewport` returns within bound.
- [x] OSR views are never attached (`runWithAttachedTabView` guard keyed on `tab.state.offscreen`); `setViewportSize` OSR path applies emulation directly.
- [x] Annotation 'auto' resolves only within `visibleTerminalSessions()`; no match or ambiguous → no terminal write, picker payload reports the skip; artifact+clipboard unchanged.
- [x] `tabhost.tabClosed` journaled on every close path incl. `disposeChildViewContents`, with `source`, `capsuleId`, `projectId`, `urlOrigin`.
- [x] Hub topology equivalent of "two project windows": with the hub presenting B and the Terminal Manager live, a pick on A's tab naming sessionB writes only to B's PTY; naming sessionA is refused `foreign-target-refused` and journaled (phase-06 evidence).

## Risks

- P3 raster mechanism is a strong inference (CEF OSR mechanism); spike before committing — fallback: fixed-size hidden capture-host window.
- P1 partial rollout (unlisted seam still throws ambient) keeps the deadlock — full `hostForTabOrBootstrap` call-site inventory required.
- `switchSession` mutates the one global active id — resolving a window-scoped session still re-points other windows' presented active (pre-existing debt, flagged).
- `.js` twins beside `.ts` sources are build artifacts — edit `.ts` only.
<!-- slug: multi-window-binding-and-annotation-routing -->
