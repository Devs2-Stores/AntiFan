---
phase: 5
title: "Renderer, Navigation & IPC Isolation"
status: pending
priority: P1
effort: "1-2d"
dependencies: [4]
---

# Phase 5: Renderer, Navigation & IPC Isolation

## Overview

Move external web content to context-isolated preload APIs and close navigation, vault IPC, cookie, and mobile exposure boundaries without weakening browser functionality.

## Requirements

- Functional: Required tab/preload functions remain available through explicit `contextBridge` APIs or Main-owned CDP execution.
- Functional: Vault/password/cookie IPC validates trusted sender frame and intended owner before reading or mutating secrets.
- Functional: Existing navigation policy is enforced consistently at direct navigation, redirect, `window.open`, and OAuth popup boundaries; this phase does not redesign normal user browsing policy.
- Non-functional: External content runs with `contextIsolation: true`; no shared-world privileged objects or broad IPC channels remain.

## Architecture

Treat toolbar/internal renderer and arbitrary web content as separate trust classes. Internal UI receives a narrow versioned preload API. Privileged automation uses CDP isolated world 1004; explicit inspection APIs that must observe page globals may read the page main world through a narrowly authorized, result-sanitized path. Main authorizes IPC using sender WebContents/frame identity and resource owner.

## Related Code Files

- Modify: `src/main/security/security-policy.ts`
- Modify: `src/preload/tab-preload.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/browser/local-credential-vault.ts`
- Modify: `src/main/browser/local-session-vault.ts`
- Modify: `src/main/browser/oauth-popup-manager.ts`
- Modify: `src/main/browser/tab-automation-host.ts`
- Modify: navigation/window-open/cookie IPC registration sites in `src/main/`
- Modify: preload, IPC origin, navigation, popup, vault, and live interaction tests
- Delete: shared-world privileged globals and sender-unverified vault handlers

## Implementation Steps

1. Inventory every preload export, page-world dependency, renderer caller, IPC channel, and navigation handler before toggling isolation.
2. Classify each function: internal UI via `contextBridge`, privileged mutation via Main/CDP isolated world 1004, or explicit read-only page-world inspection when page globals are the documented target; include current `tab-automation-host.ts` execution.
3. Introduce the final narrow preload API and migrate every caller; do not retain a generic execute/IPC escape hatch.
4. Enable `contextIsolation: true` for external tabs and remove `contextIsolation: false` compatibility behavior.
5. Validate vault/password/cookie IPC against trusted sender WebContents, frame URL/origin, profile/capsule ownership, and requested operation scope.
6. Reuse one existing URL policy across `will-navigate`, `will-redirect`, `setWindowOpenHandler`, and OAuth popup creation only to prevent bypass/foreground theft; do not broaden into a navigation-policy redesign.
7. Keep mobile networking loopback by default; explicit user opt-in enables LAN bind/advertisement with scoped authentication and firewall guidance. Never advertise an unreachable or implicit LAN mode.
8. Add negative tests for hostile page IPC, subframe calls, redirects, popup chains, cookie import without binding, and shared-world access.
9. Run real interaction smoke for toolbar, tabs, split mobile view, inspect/evaluate, capture, visual compare, rulers/lens, downloads, and credential UI.

## Success Criteria

- [ ] External pages cannot access privileged preload objects from their JavaScript world.
- [ ] Internal UI operations work through a narrow typed bridge.
- [ ] Untrusted top frames and subframes cannot list/clear vault credentials or import cookies.
- [ ] Redirect and popup paths enforce the same navigation policy as direct navigation.
- [ ] Privileged agent mutation uses isolated execution; authorized page-global inspection remains available without exposing preload privilege.
- [ ] Mobile endpoint behavior matches its documented bind/authentication mode.

## Risk Assessment

- **Hidden shared-world dependency:** enabling isolation may silently break inspector/capture helpers. Signal: runtime smoke lacks a function while typecheck remains green. Response: migrate the exact use case to contextBridge or CDP; never disable isolation globally.
- **Origin confusion:** URL-only validation can trust an attacker-controlled frame. Signal: child frame invokes vault IPC. Response: combine sender WebContents identity, frame ownership, origin allowlist, and resource scope.
- **Navigation inconsistency:** redirect or popup bypasses direct URL checks. Signal: blocked URL loads through a secondary event. Response: one policy function consumed by every Electron navigation surface.
