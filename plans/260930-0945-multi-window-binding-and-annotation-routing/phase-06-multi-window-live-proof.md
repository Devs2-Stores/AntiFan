---
title: "Phase 6: Multi-window live proof"
status: done
evidence: reports/multi-window-binding.json + reports/multi-window-binding-restart.json (18+3 checks pass, post-review rerun; kongming verdict PASS)
---

# Phase 6: Multi-window live proof

## Overview

End-to-end verification on the real desktop app. **Topology correction (verified
against index.ts:2697-2713, Oct 2026):** "two live project windows" is unreachable —
commit 8ccc3ec retired per-project windows; `openProject` routes to the singleton
'web' hub and repoints its `activeProject`. The live equivalent the probe proves:
one web hub switching A↔B, the shared 'unassigned' Terminal Manager as the second
browser shell, and two concurrent bridge attachments.

## Requirements (all verified live by scripts/probe-multi-window-binding.cjs)

- [x] Two browser shells live (hub + Terminal Manager); two agent sessions bound to
      project A's and B's terminals over separate bridge pairings.
- [x] Anchor tab minted on the hub pinned to the TERMINAL's capsule
      (`getTabCapsuleId` == session capsule, Phase 2).
- [x] Hub presents A → pick on A's tab naming sessionA writes only to A's PTY;
      naming sessionB refuses `foreign-target-refused`, journaled (Phase 4);
      an 'auto'-target pick on an unresolvable workspace skips with no write.
- [x] Kill bound tab → `browser.list-tabs` still answers, `browser.navigate` refuses
      TARGET_STALE (no UNAUTHENTICATED), `browser.rebind-target` to a live
      same-project tab heals (Phase 1).
- [x] Offscreen anchor: `isTabOffscreen === true`, `browser.screenshot` returns a
      real artifact envelope (artifactRef + byteLength > 1KB), no foreground switch,
      no `capture.raster` timeout in journal (Phase 3).
- [x] `main.log` carries `tabhost.tabClosed` rows with real source attribution
      across three close paths (host 'probe-close', 'view-destroyed', bridge
      `browser.close-tab`) plus capsuleId/projectId stamps (Phase 5).
- [x] Closing the manager window leaves the hub alive, `window-close.closed`
      journaled for the manager owner (Phase 5 window-close gate).
- [x] Cold restart leg: second Electron process against the persisted profile
      reopens one hub shell presenting the PERSISTED project (B), not the env-seeded
      boot project (A), with the strip restored.

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

## Review notes (kongming post-verdict)

- 'auto' positive-resolution arm (workspace resolves to exactly one project → write)
  stays unexercised: fixture URLs never classify. Non-blocking — a false-negative
  skip loses a prompt but can never write to a foreign session, which is the
  incident invariant this phase exists to prove.
- `bridge-dev.json` is still written to the real dev data path despite
  `ANTIFAN_DATA_ROOT` — a benign env-isolation leak in the dev pairing broadcast,
  tracked separately.
- 'Two live project windows' is a re-scope, not a regression: commit 8ccc3ec4
  retired per-project windows (index.ts:2697-2713); the live equivalent under test
  is hub + Terminal Manager + concurrent bridge attachments, per probe header.
