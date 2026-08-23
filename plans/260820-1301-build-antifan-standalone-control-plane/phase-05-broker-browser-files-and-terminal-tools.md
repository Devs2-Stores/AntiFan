---
phase: 5
title: "Broker browser, files, and terminal tools"
status: completed
priority: P1
effort: "6d"
dependencies: [3]
---

# Phase 5: Broker Browser, Files, and Terminal Tools

## Overview

Consolidate browser, filesystem, and terminal capabilities behind one policy-
aware catalogue usable by MCP, WebSocket, and the standalone runtime.

## Requirements

- Functional: list, inspect, navigate/reload, bounded capture, read/write files,
  and run approved checks with explicit targets.
- Non-functional: fail-closed permissions, bounded outputs, cancellation,
  ownership, and no arbitrary code/eval by default.

## Architecture

`CapabilityCatalogue` owns schemas, aliases, risk classes, and dispatch. A
`BrowserControlPort` adapts `NativeTabHost`; `WorkspaceFilePort` enforces root
containment; `TerminalSessionPort` owns one PTY/process session per Workspace or
Run. MCP/WebSocket are transports, not separate tool registries.

## Related Code Files

- Create: `src/main/tools/capability-catalogue.ts`, `src/main/tools/browser-control-port.ts`, `src/main/tools/workspace-file-port.ts`, `src/main/tools/terminal-session-port.ts`
- Modify: `src/main/mcp/mcp-server.ts`, `src/main/bridge/bridge-server.ts`, `src/main/browser/browser-action-registry.ts`, `src/main/browser/terminal-manager.ts`
- Create: `test/main/capability-catalogue.test.ts`, `test/main/browser-control-port.test.ts`, `test/main/workspace-file-port.test.ts`, `test/main/terminal-session-port.test.ts`, `test/integration/mcp-stdio-process.test.ts`

## Implementation Steps

1. Port existing `BrowserActionRegistry` declarations into the catalogue and
   prove MCP/WebSocket parity; remove unreachable advertised-case drift and
   prevent either transport from retaining a private switch dispatcher.
2. Require an authenticated runtime lease and explicit Project/Workspace
   attachment for every external request. Make profile enumeration/sync and
   arbitrary eval separately gated capabilities, never a global high-risk flag.
3. Require `BrowserTarget` (runtime/tab/epoch/document generation) for every
   read, evidence capture, and mutation; keep active-tab resolution only at the
   legacy UI adapter edge.
4. Stage attachments through canonical realpath/no-follow checks, byte/mime/hash
   limits, and artifact IDs; never pass arbitrary renderer file paths through.
5. Add artifact staging for DOM, screenshot, console, and terminal output with
   per-field/total byte limits, secret-pattern redaction, and user-visible
   truncation reasons.
6. Split interactive PTY from one-shot command execution; track owner, cwd,
   PID/birth identity, process group, ports, timeout, and shutdown result. Scrub
   inherited credentials and dispose owned processes on runtime drain.
7. Route all MCP startup/runtime logs to stderr before transport creation and
   test stdout frame purity through process startup and shutdown.
8. Replace plaintext bridge discovery with an atomic, owner-restricted lease
   containing token, protocol version, project/runtime binding, host epoch, and
   process identity; reject stale or concurrent instances.

## Success Criteria

- [x] One catalogue drives list/schema/dispatch for all transports.
- [x] MCP and WebSocket cannot call a mutating or eval path outside the catalogue.
- [x] External requests without a valid lease, Project attachment, or explicit
      BrowserTarget are rejected before capability dispatch.
- [x] Cross-tab, cross-workspace, traversal, symlink/junction, and stale epoch
  attempts fail with stable typed errors.
- [x] Profile/eval capabilities require scoped grants and are absent from the
      default external catalogue.
- [x] No unbounded base64/HTML/terminal output enters a Run event.
- [x] Default external policy exposes read/introspect only; mutations require an
  explicit grant and exact runtime attachment.
- [x] Owned process shutdown never kills an unrelated Windows process.

## Risk Assessment

`NativeTabHost` is a large extraction boundary and terminal PTY packaging may
require Electron ABI rebuilds. Keep compatibility wrappers and validate Windows
packaging before removing the singleton path.
