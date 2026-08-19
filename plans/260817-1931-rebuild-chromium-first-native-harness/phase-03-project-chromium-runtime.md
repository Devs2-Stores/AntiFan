---
title: "Phase 3: Project-owned Chromium Runtime"
status: done
---

# Phase 3: Project-owned Chromium Runtime

## Overview

Replace the singleton `NativeTabHost` and global partition with one ProjectRuntime
per open Project. Each Project receives one BrowserWindow, one persistent profile,
one complete tab registry, and one browser lifecycle/epoch.

## Requirements

- Opening the same Project focuses its existing window/runtime.
- Opening another Project creates a different BrowserWindow/runtime/partition.
- Every sender WebContents, tab, popup, browser event, capture, and observer is
  owned by exactly one Project.
- `activeTabId` is local UI state only; tool execution never resolves through it.
- Browser mutations require exact Project, browser epoch, tab, WebContents, and
  document generation.
- Chromium profile persistence relies on the Project partition; broad plaintext
  cookie export/import is removed.
- Project suspension follows explicit lifecycle and memory rules.
- Materialization and teardown are serialized per Project and fenced by a durable
  runtime generation so stale close/crash callbacks cannot clear a newer runtime.
- Native unmanaged popups and hidden MCP-owned Chromium instances are forbidden.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Add | `src/main/projects/project-runtime.ts` | Own one Project window, browser gateway, stores, terminal and Harness handles |
| Add | `src/main/projects/project-runtime-manager.ts` | Materialize/focus/suspend/close runtimes and map senders to Projects |
| Add | `src/main/projects/project-profile-lifecycle.ts` | Unique partition ownership, flush, tombstone, delete/retry lifecycle |
| Modify | `src/main/native-tab-host.ts` | Constructor-injected Project identity/partition; explicit-target APIs |
| Modify | `src/main/browser/tab-manager.ts` | Project-owned tab identity and exact generations |
| Modify | `src/main/browser/tab-controller.ts` | Remove active/global target fallback |
| Modify | `src/main/browser/session-manager.ts` | Project partition and browser epoch lifecycle |
| Modify | `src/main/browser/console-observer.ts` | Project/tab-scoped bounded events |
| Modify | `src/main/browser/network-observer.ts` | Project/tab-scoped bounded and redacted events |
| Modify | `src/main/session-store.ts` | Project tab metadata only; Chromium owns cookie persistence |
| Modify | `src/main/window-manager.ts` | Project window ownership and close/suspend policy |
| Modify | `src/main/app-main.ts` | AppSupervisor and ProjectRuntimeManager startup |
| Modify | `src/main/index.ts` | Route all browser IPC through sender-owned ProjectRuntime |
| Modify | `src/main/mobile-remote-server.ts` | Bind remote control to an authorized ProjectRuntime or disable it |
| Modify | `src/main/mcp/agent-mcp-server.ts` | Remove browser ownership; require explicit running Project attachment |
| Modify | `src/main/mcp/mcp-child.ts` | Fail closed instead of launching hidden Chromium |
| Add | `test/main/project-runtime-manager.test.ts` | Duplicate-open, sender routing, lifecycle, and recovery tests |
| Add | `test/main/project-browser-isolation.test.ts` | Partition, tab, cookie, epoch, and cross-project rejection tests |
| Add | `test/e2e/multi-project-browser.cjs` | Two-window Project isolation smoke |

## Implementation Steps

1. Introduce `AppSupervisor`/`ProjectRuntimeManager`; remove app-global host
   lookup from new paths. Add a per-Project lifecycle mutex/single-flight and
   generation-fence every asynchronous close/crash callback.
2. Create default partition `persist:antigravity-project-<projectUuid>` or use the
   catalog's unique legacy alias for the selected imported Project, then inject
   it into every Project WebContentsView and browser service.
3. Map BrowserWindow/renderer WebContents IDs to ProjectRuntime and validate this
   mapping before trusting requested `projectId`.
4. Make every tab and observer event carry Project/browser epoch,
   `tabRuntimeInstanceId`, and exact document generation. Change stale checks from
   ordering to equality; revoke bindings immediately on renderer crash/destruction.
5. Replace active-tab commands with explicit target methods. UI commands resolve
   active tab in renderer/Main once and call the same explicit API.
6. Deny unmanaged native popup creation. Recreate allowed `_blank`/`window.open`
   destinations as Project tabs, or synchronously adopt the created WebContents
   into the source Project registry. Define OAuth/modal/opener behavior.
7. Persist Project tab metadata and rotate browser epoch on runtime recreation;
   restored tabs receive new runtime identities.
8. Implement `foreground`, `background-active`, `background-warm`, `suspended`,
   `recovering`, and `closed` transitions with deterministic budget/LRU policy.
9. Block suspension while a run, PTY, process, capture, annotation, lease, or
   nonterminal mutation exists. Include downloads, DevTools/auxiliary WebContents,
   and debugger/CDP attachments; never silently terminate these resources.
10. Route second-instance/deep-link Project-open intents through the catalog so an
    existing Project runtime is focused and a second owner is never created.
11. Disable browser-owning MCP before Project automation is enabled. Later MCP and
    mobile/remote sessions must select and authorize one running ProjectRuntime.
12. Implement profile deletion with an exclusive Project lock, durable tombstone,
    closed/no-blocker precondition, awaited Chromium flush/destruction, and
    delete-on-restart recovery.

## Browser API Checklist

- [ ] `listTabs(projectId)` returns only Project-owned serializable DTOs.
- [ ] `bindTab(runId, tabId)` snapshots WebContents/document generation.
- [ ] Renderer crash/destruction revokes `tabRuntimeInstanceId` immediately.
- [ ] Read operations reject missing, cross-project, closed, or stale targets.
- [ ] Mutation operations are explicit and return authority receipts.
- [ ] Console/network/capture APIs accept explicit targets and budgets.
- [ ] No raw `WebContentsView`, `WebContents`, cookie, or session object leaves Main.

## Validation

- Project A and B can log into different accounts for the same origin.
- Catalog rejects duplicate partition ownership, and the legacy alias is never
  opened concurrently by an old/global host and an imported ProjectRuntime.
- Switching/focusing windows cannot redirect a bound operation.
- Navigation, close, restore, popup, crash, and future-generation cases fail or
  transition exactly as contracted.
- Concurrent open/open, open/suspend, reopen/close, and stale close callbacks
  produce one current runtime owner.
- `_blank`, popup, OAuth/modal, opener-close, renderer-crash, and suspension paths
  never create an unregistered Chromium owner.
- Closing a Project with live work requires explicit lifecycle handling.
- Keep-running on close preserves the exact Project runtime in background-active;
  stop-and-close reconciles runs and terminates only Project-owned processes.
- Packaged restart restores Project profile and tab metadata without reusing
  stale runtime tab IDs.
- Profile deletion survives locked files, late writes, crash, and reopen attempts
  without deleting a live or wrong Project partition.
- Suspension meets explicit RSS/process-count targets and cleans up Project-owned
  DevTools, auxiliary WebContents, downloads, and debugger attachments.

## Success Criteria

Chromium is visibly and structurally Project-owned, and no browser request can
fall back to another Project or a newly active tab.

## Risks And Rollback

Main remains a shared crash domain. Keep Project executors narrow and bounded,
and do not enable multi-Project mutation until every old singleton browser path
is either removed or proven unreachable.
