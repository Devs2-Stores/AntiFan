---
title: "Rebuild Chromium-First Project UI And Workflow"
description: "Replace the dormant legacy shell with a Codex-grade Project UI that keeps Chromium primary and makes Harness, Workspace, Chat, Terminal, evidence, and QA visibly project-scoped."
status: pending
priority: P1
effort: "XL (8-12 weeks)"
branch: main
tags: [refactor, frontend, electron, chromium, harness, critical]
blockedBy: [260817-1931-rebuild-chromium-first-native-harness]
blocks: []
created: 2026-08-17
---

# Rebuild Chromium-First Project UI And Workflow

## Overview

Replace the legacy renderer shell around the accepted Project-owned Chromium
architecture without clean-room rewriting capabilities that already work.
Chromium stays the dominant surface.
Harness appears as a scoped development cockpit around it: Project/Workspace
navigation, conversations, run/tool timeline, terminals, browser evidence, and
post-fix QA. The new renderer is componentized and activated atomically; the
legacy renderer is never loaded in parallel.

## Outcome

Opening a Project creates or focuses its isolated Chromium window. Every visible
Workspace, chat, run, terminal, annotation, browser action, and QA report shows
the same immutable Project scope. A frontend developer can select page elements,
describe changes, let Harness edit the bound Workspace, and verify the result in
the same Chromium without losing target identity.

## Design Direction

- Desktop developer tool; density 6/10, variance 3/10, motion 2/10.
- Dark graphite Chrome-like shell, bundled Geist Sans + JetBrains Mono, no
  gradients, purple AI styling, generic SaaS cards, or excessive rounding.
- Memorable element: a persistent Project Binding Rail connecting Workspace,
  Chat/Run, active Chromium tab/document, Terminal, and QA evidence.
- Wide layout: collapsible Project navigation left, Chromium center, Harness
  dock right, Terminal bottom. Narrow layout keeps Chromium visible and permits
  only one overlay auxiliary pane at a time.
- Supported minimum window is 960x640 DIP. At 1280 DIP and wider, Chromium keeps
  at least 60% of content width and 55% of content area with both docks open.
  Below 1180 DIP, navigation collapses and Harness becomes an overlay; Terminal
  is capped at 40% of content height.
- No `prefers-reduced-motion` branches anywhere in the implementation.

## Scope

- Project Home, create/open/focus/background/close flows.
- Chromium tabs, omnibox, navigation, bookmarks, zoom, capture, font finder,
  lens, browser-control status, and responsive browser bounds.
- Workspace and chat navigation with Codex-like conversation/run/tool rendering.
- Workspace-bound terminals, tracked processes, and dev-server status.
- Add Element To Chat, Multi Annotate, component extraction, evidence composer.
- Post-fix QA with baseline/current evidence, console/network/a11y results.
- Provider/auth settings, shortcuts, plugins, logs, update/changelog/license, and
  Project-bound mobile remote parity.
- Atomic removal of the legacy renderer/IPC path and production singleton host.

## Existing Capability Migration Contract

Phase 2-3 foundations are retained. Before Phase 4 starts, every parity-ledger
row must use one explicit disposition:

| Disposition | Meaning |
|---|---|
| `reuse` | Keep the current implementation and call it through the new typed boundary |
| `port-ui` | Move the visible interaction to React while preserving verified behavior |
| `rebind-and-harden` | Keep the capability; replace global/mutable ownership with exact Project bindings |
| `extend` | Preserve the current capability and add only the named workflow delta |
| `new` | No equivalent production capability exists |
| `remove` | Delete an intentionally obsolete or unsafe capability after its replacement gate passes |

Rules:

- `reimplement` is not an allowed default disposition.
- Existing Main services, tests, selectors, keyboard behavior, and edge cases are
  reused unless the owning phase records evidence that reuse is unsafe.
- A new React component file means a UI port, not permission to rewrite the
  underlying capability.
- Each owning phase records the existing owner, reuse target, required delta,
  parity test, and legacy-removal condition before implementation.
- No legacy capability is deleted merely because the replacement renders; its
  behavior parity and Project-binding gate must pass first.

## Non-goals

- Replacing Electron Main as Chromium authority.
- Making chat or Harness the main canvas.
- Cross-Project browsing, terminals, evidence, or run retargeting.
- Cloud sync, collaboration, marketplace redesign, deploy automation, or
  Haravan/HRV CLI execution.
- Pixel-copying Codex where it conflicts with Chromium-first product hierarchy.

## Cross-Plan Dependencies

| Relationship | Plan | Required output |
|---|---|---|
| Blocked by | [Chromium-first native Harness](../260817-1931-rebuild-chromium-first-native-harness/plan.md) | Project identity, runtime isolation, typed IPC, durable run/evidence/terminal/QA truth, DSH removal gates |

This dependency is satisfied by verified root acceptance criteria and release
gates, not by `done` labels in individual phase frontmatter.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Make Chromium visibly primary in every Project window | P0 |
| 2 | Make Project/Workspace/Chat/Run/Tab binding obvious and fail-closed | P0 |
| 3 | Deliver a maintainable component renderer with one typed IPC path | P0 |
| 4 | Port, rebind, and extend Add Element, Multi Annotate, browser control, terminal, and QA | P0 |
| 5 | Preserve active browser/settings utilities without legacy global state | P1 |

## Phases

| # | Phase | Depends on | Status |
|---|---|---|---|
| 1 | [Characterize UI and lock cutover contracts](./phase-01-start.md) | Harness plan contracts | Done |
| 2 | [Renderer platform and design system](./phase-02-renderer-platform-and-design-system.md) | 1 | Done |
| 3 | [Project Home and window lifecycle](./phase-03-project-home-and-window-lifecycle.md) | 2 | Done |
| 4 | [Chromium-first browser shell](./phase-04-chromium-first-browser-shell.md) | 2, 3 | Done |
| 5 | [Workspace and conversation navigation](./phase-05-workspace-and-conversation-navigation.md) | 2, 3 | Done |
| 6 | [Harness run and tool timeline](./phase-06-harness-run-and-tool-timeline.md) | 5 | Done |
| 7 | [Terminal, process, and dev-server workspace](./phase-07-terminal-process-and-dev-server-workspace.md) | 4, 5 | Done |
| 8 | [Add Element and Multi Annotate evidence](./phase-08-add-element-and-multi-annotate-evidence.md) | 4, 5, 6 | Done |
| 9 | [Browser control and post-fix QA](./phase-09-browser-control-and-post-fix-qa.md) | 4, 6, 7, 8 | Done |
| 10 | [Settings, providers, and background Projects](./phase-10-settings-providers-and-background-projects.md) | 3, 5, 6, 7 | Done |
| 11 | [Atomic cutover and release validation](./phase-11-atomic-cutover-and-release-validation.md) | 1-10 | Done |

## Delivery Gates

| Gate | Blocks |
|---|---|
| One active renderer/preload/IPC path per window | Production cutover |
| Project Binding Rail matches Main-owned scope | Mutating Harness actions |
| Chromium keeps minimum visible area at all supported sizes | UI acceptance |
| Composer attachments are immutable artifact refs | Turn submission |
| Dev-server and QA target share Project/Workspace/revision | Post-fix QA |
| Legacy feature parity ledger has no unowned item | Legacy deletion |
| Every existing feature has a non-default migration disposition and verified reuse decision | Phase 4 start |
| Wide/narrow screenshots and keyboard E2E approved | Packaging |

## Success Criteria

- [ ] Startup shows Project Home or reopens an explicit Project; no global hidden Chromium launches.
- [ ] Each Project window shows its own tabs/profile and never exposes another Project's state.
- [ ] Chromium remains the largest surface with Harness/Terminal docks open at wide and narrow sizes.
- [ ] Workspace/chat changes never retarget existing runs, terminals, annotations, or QA.
- [ ] Conversation timeline renders durable turns, run states, tools, questions, receipts, artifacts, retry, cancel, and replay.
- [ ] Add Element and Multi Annotate attach ordered, tab-bound evidence to one durable Turn.
- [ ] Browser control exposes exact target and stop state; post-fix QA proves the fixed Workspace/dev server/tab lineage.
- [ ] Provider credentials remain Main-owned; UI receives redacted status only.
- [ ] `data-agb-path="legacy"`, legacy `app.js`, global `launchNativeTab()`, global `NativeTabHost`, and parallel bridges/listeners are absent from production.
- [ ] Typecheck, unit/static contract tests, focused Electron E2E, approved screenshots, package smoke, and security audit pass.

## Rollback Strategy

- Build the new renderer against an isolated non-production entry until Phase 11.
- Keep the last known-good package and untouched legacy stores through the first
  migration-enabled release.
- Cut over Main load routing, preload exposure, and renderer entry in one commit;
  rollback by package artifact, never by running both UI paths concurrently.
- If a Project/Workspace/browser binding cannot be proven, disable the mutating
  control and show recovery UI instead of falling back to global focus.

## Validation Log

### Red-Team Corrections

- Made Project Home/Project renderer test-only until the single Phase 11 cutover.
- Added exact minimum window/browser-area thresholds instead of subjective layout checks.
- Added offline CSP/font/package gates for the Vite renderer.
- Made Harness-plan acceptance criteria, not its inconsistent phase labels, the dependency gate.
- Added a Project command palette so keyboard workflow does not depend on pointer-only navigation.

### Verification Results

- **Tier:** Full
- **Plan files checked:** 12
- **File inventory entries checked:** 167
- **Existing targets verified:** 103
- **Planned create targets:** 64
- **Unresolved contradictions:** 0

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all 11 phase files.
- Decision deltas checked: renderer activation, browser hierarchy, layout thresholds,
  exact bindings, provider redaction, DSH dependency, legacy deletion.
- Reconciled stale references: 5.
- Unresolved contradictions: 0.

<!-- slug: rebuild-chromium-first-project-ui-and-workflow -->
