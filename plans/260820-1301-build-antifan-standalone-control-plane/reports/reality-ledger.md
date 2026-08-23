---
title: "AntiFan live-source reality ledger"
status: complete
created: 2026-08-20
scope: planning-only
---

# AntiFan Live-Source Reality Ledger

## Authority Rule

The checked-out source and tests are authoritative. `docs/` and older plans are
design records only until a symbol/path/behavior is verified. Existing dirty
worktree changes are user-owned and must be preserved.

## Verified Current Owners

| Area | Live owner | Evidence | Planning consequence |
|---|---|---|---|
| Bootstrap/window | `src/main/index.ts` | current entrypoint | Extract adapters without assuming Project runtime exists |
| Browser/chat/dispatch | `src/main/browser/native-tab-host.ts` | large host owns tabs, IPC, chat, transcript, terminal routing | Keep compatibility wrapper during extraction |
| Terminal | `src/main/browser/terminal-manager.ts` | singleton `child_process.spawn` manager | Replace only after owner/session contract and Windows tests |
| MCP | `src/main/mcp/mcp-server.ts` | direct host reference, static tools/switch | Make transport adapter over one catalogue |
| Browser catalogue | `src/main/browser/browser-action-registry.ts` | tested but not production authority | Promote only after explicit-target port |
| Antigravity delivery | `src/main/bridge/antigravity-command-client.ts` | v2 validation/unknown/late receipt behavior | Preserve behind backend adapter |
| Transcript observation | `src/main/bridge/transcript-syncer.ts` | scans Antigravity session files | Import/projection only, never standalone truth |
| Browser evidence | `src/main/bridge/annotation-manager.ts` | bounded/TTL evidence path | Extend budgets/redaction, do not duplicate store |

## Documented But Not Verified In Source

The following names are described by docs/older plans but are absent as live
source owners in this checkout: `ProjectRuntime`, `CapabilityBroker`,
`project-app.html`, `project-window.ts`, `app-shell-ipc.ts`,
`project-runtime.ts`, and a utility `Harness` process. They are target contracts,
not shipped implementation. Phase 2 must choose import versus supersession before
any new files with similar responsibilities are created.

## Hard Invariants Frozen For Later Phases

- No autonomous mutation may resolve an omitted tab to the active tab.
- No workspace tool may use `process.cwd()` or a broad ancestor heuristic as
  authority; canonical containment is required.
- A transcript, screenshot, hook, or MCP response without Project/Workspace/
  Run/Attempt binding is observation only.
- `unknown` after a dispatch boundary is durable and never auto-retried.
- Exactly one capability catalogue and one receipt authority may exist.
- DSH/Orca are research references; Antigravity is optional compatibility.

## Overlap Decisions

- `260817-1931-rebuild-chromium-first-native-harness`: import verified invariants;
  supersede absent runtime files in this simplified tree; do not run two brokers.
- `260817-2217-rebuild-chromium-first-project-ui-and-workflow`: retains renderer
  ownership; this plan exposes contracts and a thin sidebar slice only.
- `260818-1533-project-harness-coding-tool-loop`: retains tool-loop intent; this
  plan owns backend-neutral transport/recovery and reuses one catalogue.

## Open Spike Decisions

1. Codex JSONL/resume/cancel lifecycle and protocol stability.
2. `node-pty` versus one-shot terminal scope for the first Windows release.
3. Raw JSONL versus SQLite after the first recovery vertical slice.
4. DSH adapter viability under Windows, cancellation, and security gates.

