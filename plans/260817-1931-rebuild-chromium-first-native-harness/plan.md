---
title: "Rebuild Chromium-First Native Harness"
description: "Replace the DSH-coupled AgentEngine with a project-isolated native Harness while keeping Chromium as the primary product surface."
status: in-progress
priority: P1
effort: "XL"
tags: [architecture, electron, chromium, harness, migration]
blockedBy: []
blocks: [260817-2217-rebuild-chromium-first-project-ui-and-workflow]
created: 2026-08-17
---

# Rebuild Chromium-First Native Harness

## Overview

Rebuild the app around a project-isolated, Chromium-first runtime. Each Project
owns one visible BrowserWindow, one persistent Chromium profile/partition, its
complete tab set, workspace registry, chat/run state, terminal manager,
artifacts, and an app-owned Harness utility process. Electron Main remains the
only authority for Chromium and side effects. DSH is retained only as research
reference and removed from the shipping runtime.

The accepted architecture and rejected alternatives are recorded in
[architecture.md](./architecture.md).

## Outcome

Deliver a Codex-like project model in which a run cannot cross project,
workspace, tab, document, terminal, or chat boundaries accidentally, while the
Harness can inspect and control all Chromium tabs belonging to its Project and
can perform evidence-backed post-fix QA.

## Constraints

- Chromium is the primary product surface; Harness work must not restart, own,
  or replace it.
- Each Project has a distinct BrowserWindow/runtime and uniquely owned persistent
  Chromium partition. New partitions use durable Project UUID, never folder path;
  one imported Project may retain the unique legacy partition alias.
- Each ChatSession is pinned to one Workspace. Existing runs and terminals are
  never retargeted by UI focus or workspace changes.
- Renderer and utility processes never receive raw Electron objects or raw
  credentials.
- Main is the sole writer for durable state and the sole executor of browser,
  filesystem, checkpoint, terminal, and provider side effects.
- Large DOM, screenshot, diff, and command outputs cross process boundaries by
  artifact handle, never inline base64.
- Unknown mutation outcomes are never automatically retried.
- Legacy data is detected and imported idempotently; source files are not
  silently deleted or overwritten.
- DeepSeek remains a normal model provider. No DSH runtime protocol, storage,
  parser, tool, label, or compatibility obligation remains after cutover.

## Non-goals

- One full Electron/Chromium OS process per Project.
- Exact restoration of live page JavaScript state or PTYs after suspension.
- Cross-project browser, cookie, terminal, artifact, or chat access.
- Automatic deployment or Haravan/HRV CLI execution.
- Keeping a permanent dual-runtime fallback to the old DSH flow.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Make Project the top-level isolation and lifecycle boundary | P0 |
| 2 | Give every Project its own Chromium window, profile, tabs, state, terminal manager, and Harness supervisor | P0 |
| 3 | Replace mutable global context with immutable run/workspace/tab bindings | P0 |
| 4 | Make Add Element, Multi Annotate, browser control, and QA durable evidence workflows | P0 |
| 5 | Add crash-safe run journals, leases, receipts, checkpoints, event replay, and migration | P0 |
| 6 | Remove DSH/Cordis runtime coupling while preserving DeepSeek as a provider | P1 |

## Phases

| # | Phase | Depends on | Status |
|---|-------|------------|--------|
| 1 | [Contracts and characterization](./phase-01-contracts-and-characterization.md) | - | Pending |
| 2 | [Durable project state and migration foundation](./phase-02-durable-project-state.md) | 1 | Pending |
| 3 | [Project-owned Chromium runtime](./phase-03-project-chromium-runtime.md) | 1, 2 | Pending |
| 4 | [Workspace, chat, terminal, and process isolation](./phase-04-workspace-chat-terminal-isolation.md) | 1, 2 | Pending |
| 5 | [Project Harness utility process](./phase-05-project-harness-utility.md) | 1, 2, 3, 4 | Pending |
| 6 | [Capability broker, leases, receipts, and checkpoints](./phase-06-capability-broker.md) | 3, 4, 5 | Done |
| 7 | [New renderer, preload, chat, and run path](./phase-07-renderer-chat-run-cutover.md) | 4, 5, 6 | Done |
| 8 | [Add Element and Multi Annotate evidence workflows](./phase-08-annotation-evidence.md) | 3, 6, 7 | Done |
| 9 | [Project browser automation and post-fix QA](./phase-09-browser-automation-qa.md) | 3, 6, 8 | Done |
| 10 | [DSH removal, legacy import, rollout, and release validation](./phase-10-dsh-removal-rollout.md) | 1-9 | Done |

## Delivery Gates

| Gate | Required before |
|------|-----------------|
| Project identity on every IPC envelope and sender-window ownership checks | Opening two Projects concurrently |
| Immutable workspace/browser binding and exact document-generation checks | Any mutating Harness tool |
| Durable accepted-versus-terminal mutation receipts | Retry, background runs, or crash recovery |
| Workspace and tab leases | Concurrent mutating runs |
| Artifact handles and payload budgets | Multi Annotate and automated QA |
| Main-owned credential vault with redacted renderer status | Provider cutover |
| Utility crash reconciliation and event replay | Closing/reloading a Project window during a run |
| Legacy migration dry-run report with originals preserved | Removing old stores/runtime |
| Migration apply reaches `verified` and rollback sources remain readable | Atomic production authority cutover |

## Success Criteria

- [ ] Two open Projects have different windows, Chromium partitions, tab registries, chats, terminals, artifacts, and Harness processes.
- [ ] Browser, terminal, IPC, and run requests from one Project cannot name or reach resources owned by another Project.
- [ ] A ChatSession and every HarnessRun remain pinned to their original Workspace even when UI focus changes.
- [ ] Browser tools can enumerate all tabs inside the run's Project, but mutations require an explicit tab/document binding and fail closed when stale.
- [ ] Add Element and Multi Annotate preserve ordered typed evidence, screenshots, URL, viewport, and document generation through Turn creation and model context assembly.
- [ ] Post-fix QA enforces reload/rebind and stability barriers, captures browser/console/network/accessibility evidence, and fails on missing or mismatched baselines.
- [ ] Terminal commands and long-running processes are tracked by Project, Workspace, PID, cwd, and port; suspension never silently kills them.
- [ ] Renderer reload, utility crash, and Main restart recover durable runs without duplicating accepted mutations.
- [ ] Credentials, cookies, raw page bodies, and large artifacts are absent from renderer state, utility IPC, logs, and diagnostic export.
- [ ] DSH trajectory/checkpoint/goal/parser/runtime code and Cordis shell are absent from the production graph; DeepSeek provider coverage still passes.
- [ ] Typecheck, unit tests, static IPC/listener scans, focused multi-project E2E, browser/annotation/QA E2E, packaged utility smoke, and security audit pass.

## Rollback Strategy

- Deliver phases behind internal cutover gates until their acceptance tests pass;
  do not ship a permanent dual Harness runtime.
- Keep pre-migration bytes and a migration ledger so a previous release can read
  its own legacy data after rollback.
- Roll back by release artifact and schema-compatible snapshots, not by replaying
  unknown mutations or copying new state into legacy DSH files.
- Project Chromium profile deletion is always a separate explicit user action.

<!-- slug: rebuild-chromium-first-native-harness -->
