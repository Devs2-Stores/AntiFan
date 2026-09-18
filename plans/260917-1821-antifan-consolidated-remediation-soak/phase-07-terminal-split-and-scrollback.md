---
title: "Phase 7: Terminal split, scrollback & hrv coupling"
status: todo
---

# Phase 7: Terminal split, scrollback & hrv coupling

## Overview

The split pane **is** an independent terminal (user decision A, confirmed with a
screenshot: own pane, label "Terminal (Split)", own PowerShell). Three gaps make
it invisible to every surface, and one gap makes the alt-screen TUI look broken
when it is behaving as designed.

Transport is **not** broken: split bytes reach Main and the renderer. The gaps are
projection and authority.

| Gap | Mechanism (audit §3.4, §4.1) |
|---|---|
| **M1** tab strip built from base-only list | `terminal-manager.ts:1879` filters `!s.splitOf`; `listSessions` keeps only the **first** split per parent (`:1881-1886`); renderer wrap keyed by base id (`standalone.js:3285`), list at `:3871`, activity computed for splits (`:4050`) but presented via a raw-id lookup that returns silently (`:3216-3217`) |
| **M2** no data source | `SessionSummary` (`terminal-manager.ts:399-421`) lacks `splitOf`/`splitCwd`/`state`/`exitCode`; `TerminalSessionDiagnostics` **has** `splitOf` (`:435`); `altScreen` is tracked (`:215`, `:1343-1347`) but never surfaces |
| **M3** resolvers refuse splits | `terminal-manager.ts:2240`; `native-tab-host.ts:5870-5871` ("Split panes are not claimable targets"), `:6642`, `:6661-6662`, `:6688-6692` → QA/Haravan cursor falls into a shell that never ran the dev server → `DURABILITY_FAILED` |
| **Scrollback** | alt-screen keeps no scrollback by design; AntiFan's own hydration replays raw bytes including `ESC[?1049h` (`standalone.js:1558-1561`, snapshot tail at `:1508-1511`), auto-scroll pins on every write (`:1716-1781`, `:2025-2033`), and no transcript affordance exists although the server keeps `MAX_TRANSCRIPT_BYTES = 4 MiB` (`terminal-manager.ts:354`) and serves `getFullBuffer` (`:1978-1985`, IPC `native-tab-host.ts:1624-1628`) |

Advertising `terminal.*` on the MCP surface is a **separate prerequisite** owned
by phase 6 (audit: fixing the projection alone changes nothing the agent can see,
because `scripts/antifan-omp-mcp.cjs` has zero `terminal.` lines).

## Requirements

- **R1 (M1)** A split pane appears in the tab strip as its own entry, keyed by its
  own id, with its own activity state. Do **not** inherit the first-split-only
  limitation: two splits of one parent must both be present (audit's explicit
  trap). Keep existing base-pane behavior unchanged.
- **R2 (M2)** `SessionSummary` carries `splitOf` and the split's own
  `cwd`/`state`/`exitCode` (cwd fixed at creation is acceptable and must be
  labelled), and `altScreen` reaches diagnostics/summary. One line in the
  diagnostics payload is enough; no new source of truth.
- **R3 (M3)** The terminal resolvers accept a split pane as a claimable target
  (QA cursor and Haravan cursor can name it), so a dev server running in the split
  is reachable. If a resolver delegates to a base-pane-only helper, fix the helper
  where the audit's anchors say (do not fork a second resolver).
- **R4 (scrollback)** Ship the honest, labelled fix: a transcript view rendered
  from `getFullBuffer` (reuse `transcriptToPlainText` `standalone.js:496-521` and
  the `<pre>` pattern of `renderSleepPreview` `:534-575`; drop the sleeping-only
  gate at `:2052`), labelled **lossy**, plus `altScreen` in diagnostics. Do **not**
  promise scrollback inside the alternate buffer, and do not strip `1049` from the
  replay alone (without alt-screen emulation the TUI frames become scrollback
  noise — the audit pairs them).
- **R5** Auto-scroll pin is reduced so a user-initiated scroll is not dragged back
  by a TUI redraw (keep pin-on-write for the non-scrolled case; release it while
  the viewport is not at the bottom).
- **R6** The renderer changes must keep the existing terminal pool contracts
  (pane ids, active-pane selection) and pass the terminal lanes
  (`test:terminal-transport`, `test:terminal-rename`, plus the toolbar QA lane).

## Related code files

- Modify: `src/main/browser/terminal-manager.ts` — `SessionSummary` `:399-421`,
  diagnostics `:435`, `listSessions` `:1879-1886`, resolvers `:2240`.
- Modify: `src/main/browser/native-tab-host.ts` — split refusal sites `:5870-5871`,
  `:6642`, `:6661-6662`, `:6688-6692` (region note: the other plan's file-region
  split claims `native-tab-host.ts` after `:2247`; these anchors are inside it, so
  state them in the commit body and keep the edit minimal).
- Modify: the renderer — locate `standalone.js` (glob for it; anchors above are in
  the renderer bundle).
- Modify: `src/main/tools/terminal-capabilities.ts` only if a capability wire
  changes (`registerTerminalCapabilities` is already wired unconditionally).
- Tests: extend the terminal transport/rename lanes; add a split-projection case
  where the closest harness convention exists.

## Implementation steps

1. M2 first (data), then M1 (projection), then M3 (authority): the strip cannot
   key a split that the summary does not name.
2. `listSessions`: emit one entry per split (all splits, not the first), each with
   its own id and activity source; keep base entries as-is.
3. Renderer: wrap/list/activity lookups resolve split ids; activity for a split
   marks its own entry (and optionally the parent's aggregate — but never the
   silent return).
4. Resolvers: accept `splitOf`-carrying sessions as targets where the refusal
   currently names them unclaimable; prove with a unit case that a split id
   resolves and an unknown id still refuses.
5. Transcript view: render `getFullBuffer` text with a `lossy` label, wire the
   affordance for any session, add `altScreen` to diagnostics.
6. Auto-scroll: release the pin while scrolled up; restore on return to bottom.
7. Run the terminal lanes + `test:main`.

## Todo

- [ ] `SessionSummary` carries split identity and split state
- [ ] `listSessions` lists every split (not only the first)
- [ ] Renderer strip/wrap/activity key split ids
- [ ] Resolvers accept split targets; unknown ids still refuse
- [ ] Labelled lossy transcript view from `getFullBuffer`
- [ ] `altScreen` in diagnostics; auto-scroll pin released while scrolled up
- [ ] Terminal lanes green

## Success criteria

- [ ] A running split appears in the strip with its own id and its own activity;
      two splits of one parent both appear.
- [ ] A split pane is a claimable target for the terminal resolvers (proven by a
      unit case), and QA cursor can name it.
- [ ] A TUI in alt-screen offers a labelled lossy transcript and `altScreen: true`
      in diagnostics; no promise of scrollback inside the alternate buffer.
- [ ] `npm run compile`, terminal lanes and the unit suite pass with **no test
      widened**.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Renderer changes break the pane pool contract. | Keep pane ids and active-pane semantics untouched; the lanes that pin them run before commit. |
| Accepting split targets widens authority. | Only split sessions owned by the same session/user resolve; unknown ids keep refusing — asserted by a negative unit case. |
| Rollback | Revert the touched files; the projection is additive. |
