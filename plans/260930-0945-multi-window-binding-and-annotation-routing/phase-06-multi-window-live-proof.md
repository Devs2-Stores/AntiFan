---
title: "Phase 6: Multi-window live proof"
status: pending
---

# Phase 6: Multi-window live proof

## Overview

End-to-end verification on the real desktop app with two live project windows —
reproduces the incident topology (Whenever + a second project window, e.g. Comnieusiba/
Hapas) and proves each fix against live MCP calls, not only unit tests.

## Requirements

- [ ] Two project windows live; start an agent session bound to project A's terminal.
- [ ] Anchor tab minted into project A's capsule (verify via `tabs.list` affiliation /
      `workspace-capsules.json` stamp — Phase 2).
- [ ] Switch project-B window's terminal to active; pick an element in window A with
      target 'auto' → prompt lands ONLY in window A's session (or reported skip); never
      in B (Phase 4).
- [ ] Close/kill the agent's bound tab → `anti.browser.tabs.list` still returns scoped
      rows (typed degrade, no UNAUTHENTICATED); `anti.browser.rebind_target` to an
      explicit live tabId succeeds (Phase 1).
- [ ] Fresh offscreen agent tab with NO `set_viewport`: `anti.browser.evaluate`
      `innerWidth>0`, rAF probe true, `anti.screenshot.viewport` returns bytes inside
      bound; journal shows no `capture.raster outcome:'timeout'` (Phase 3).
- [ ] Close several tabs through different paths (toolbar, MCP, bridge, host dispose) →
      `main.log` carries `tabhost.tabClosed` rows with source/capsuleId/projectId
      (Phase 5).

## Related Code Files

- Exercise: `src/main/bridge/bridge-server.ts`, `src/main/index.ts`,
  `src/main/browser/*`, `src/main/tools/browser-control-port.ts`
- Evidence: `<runtime>/logs/main.log`, `.antifan-data/config/workspace-capsules.json`

## Implementation Steps

1. Launch app, open two project windows (A = target project, B = decoy with active terminal).
2. Run an MCP session against A; perform the scripted actions above.
3. Collect `tabs.list` affiliation rows, journal lines, capture timing, terminal write
   destination.

## Success Criteria

All P0 acceptance criteria observable live: no foreign-terminal write, no
UNAUTHENTICATED deadlock, offscreen capture succeeds, every close is attributed.

## Risks / Rollback

- Scope creep onto unmodified paths (kongming) — script only the listed actions.
- Live verification requires both windows + a real terminal per project; if a second
  real project isn't available, use a scratch workspace root as project B.
