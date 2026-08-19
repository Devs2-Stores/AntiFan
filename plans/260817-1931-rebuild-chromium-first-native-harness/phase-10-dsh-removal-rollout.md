---
title: "Phase 10: DSH Removal, Legacy Import, Rollout, And Release Validation"
status: done
---

# Phase 10: DSH Removal, Legacy Import, Rollout, And Release Validation

## Overview

Complete the native cutover, import legacy user state non-destructively, remove
DSH/Cordis and old global runtime paths, update Chromium-first product authority,
and pass the full multi-Project release matrix.

## Requirements

- No production runtime, UI, storage, comment, protocol, or test depends on DSH.
- DeepSeek remains supported through ProviderGateway.
- MCP is an optional adapter to the Project CapabilityBroker; it cannot launch,
  own, restart, or silently substitute Chromium.
- Legacy import runs in detect/report mode before apply and preserves originals.
- Old global Chromium partition remains the unique durable alias of at most one
  explicitly chosen imported Project; it is never cloned or renamed.
- A literal historical provider key is revoked outside code and removed from all
  tracked/runtime state before release.
- Product docs describe Project-owned desktop Chromium as the primary authority.
- Final package contains one active listener/IPC/run path for each feature.

## Removal Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Delete | `src/main/services/trajectory-harness-service.ts` | Remove DSH trajectory/checkpoint/goal runtime |
| Delete/refactor | `src/main/agent-engine.ts` | Remove DSH parser, mutable global workspace/tab, direct tools, and old loop |
| Delete | `src/main/cordis/root-context.ts` | Remove unused IoC shell |
| Delete | `src/main/cordis/types.ts` | Remove unused IoC types |
| Modify | `src/main/ai-service.ts` | Remove old AgentEngine/DSH run path after ProviderGateway cutover |
| Modify | `src/main/providers/types.ts` | Remove DSH terminology and textual tag assumptions |
| Modify | `src/main/index.ts` | Remove duplicate/global handlers, hidden Chromium Harness launch, old exports |
| Modify | `src/main/mcp/agent-mcp-server.ts` | Require explicit Project broker attachment |
| Modify | `src/main/mcp/mcp-child.ts` | No hidden browser/runtime authority |
| Modify | `src/main/mcp/tool-schema.ts` | Replace AgentEngine imports with broker capability catalogue |
| Modify | `src/main/mobile-remote-server.ts` | Explicit authorized Project binding or disabled service |
| Modify | `src/renderer/app.ts` | Remove DSH labels, old stream state, old Add/Multi/QA paths |
| Delete | `test/main/trajectory-harness-service.test.ts` | Remove obsolete runtime tests |
| Delete | `test/main/cordis-lifecycle.test.ts` | Remove obsolete shell tests |
| Replace | `test/main/agent-engine.test.ts` | Harness controller/broker/provider replacement coverage |
| Modify | `test/main/platform-conventions.test.ts` | Explicit Workspace service construction |
| Modify | `test/e2e/feature-audit.cjs` | New Project Runtime/Harness feature assertions |
| Modify | `test/e2e/tab-reorder-runner.cjs` | Project-owned NativeTabHost fixture |
| Modify | `test/e2e/toolbar-visibility.cjs` | Project-owned window/runtime fixture |
| Modify | `test/e2e/toolbar-narrow-visibility.cjs` | Project-owned narrow-window/runtime fixture |
| Modify | `package.json` | Remove Cordis; add final verification scripts/dependencies |
| Modify | `package-lock.json` | Lockfile update |
| Modify | `docs/operations.md` | Project lifecycle, process ownership, migration, rollback |
| Modify | `docs/security-model.md` | Project isolation, Utility, broker, vault, mutation journal |
| Modify | `package.json` description | Desktop Chromium is primary Project surface, not extension fallback authority |

## Implementation Steps

1. Run legacy detection and show Project/profile/chat/workspace/auth/DSH import
   plan. Resolve ambiguous Project/Workspace bindings explicitly.
2. Import Project catalog, Workspaces, chats/turns, provider preferences, and the
   selected legacy Chromium partition alias using deterministic IDs and migration
   states through `verified`.
3. Import DSH trajectories only as immutable `legacy-reference` artifacts; never
   resume them. Archive unsafe absolute-path checkpoints pending inspection.
4. Move credentials into vault or require re-authentication. Revoke/remove the
   historical literal key and verify it is absent from source and built output.
5. Verify the Phase 7 cutover-readiness report, legacy rollback sources, and
   migration `verified`, then atomically switch all UI/preload/Main/MCP production
   authority to Project Runtime, Harness, broker, evidence, terminal, and QA.
6. Delete old DSH, Cordis, global AgentEngine, hidden Chromium, duplicate IPC, and
   obsolete tests only after replacement characterization/integration tests pass.
7. Update security/operations/product authority documentation and diagnostics.
8. Run full validation and inspect packaged contents/runtime behavior.
9. Perform consistency sweep: no global current Project/Workspace/active-tab tool
   lookup, no raw secrets/base64/cookie exports, no dead parallel bridge/listener.
10. Run an exact caller/import/test inventory before deleting AgentEngine or
    changing NativeTabHost construction; no stale consumers or fixtures remain.

## Rollout Stages

1. Project Runtime and stores with read-only browser/Harness capability.
2. Explicit-target browser control and chat/run replay.
3. Workspace/terminal mutations after lease/receipt crash matrix passes.
4. Add Element/Multi Annotate and single-target QA.
5. Multi-tab QA, multiple open Projects, and background runs.
6. Remove old runtime from the release graph and ship migration-enabled package.

Each stage is a release gate, not a permanent dual-runtime feature. Unknown
mutation outcomes or migration ambiguity block advancement.

## Full Verification

### Static And Unit

- `npm run typecheck`
- full `npm test`
- duplicate IPC switch/listener/event parity scanner
- DSH/Cordis/global singleton/dead bridge search
- secret/base64/cookie-export search

### Integration And E2E

- two Project windows with isolated cookies, tabs, chats, terminals, artifacts,
  utilities, events, and browser control;
- workspace switch without chat/run/terminal retarget;
- utility/Main/renderer crash and replay matrix;
- Add Element, Multi Annotate, multi-tab browser control, post-fix QA;
- lease conflicts, mutation unknown/reconciliation, checkpoint conflict restore;
- valid/corrupt/repeated migration with unchanged originals;
- crash recovery at every catalog/Project/artifact migration state;
- MCP attaches to explicit running Project and fails closed when unavailable.

### Package And Security

- `npm run build:prod`
- `npm run package:smoke`
- packaged Utility entry starts and reconnects;
- `npm audit --audit-level=high --omit=dev`
- diagnostics and built artifacts contain no credentials, cookies, raw page
  bodies, or the historical literal key.
- long-duration event/artifact load, compaction, reference-count GC, quota
  pressure, and interrupted maintenance recovery.

## Success Criteria

The production package has one Chromium-first, Project-isolated native Harness
architecture; legacy user state is recoverably imported; DSH/Cordis runtime code
is gone; and all release gates pass without cross-project or wrong-target effects.

## Risks And Rollback

- Do not delete original legacy stores during migration-enabled releases.
- A rollback uses the previous signed/package artifact and its untouched legacy
  sources, not reverse writes from new schemas.
- If a nonterminal mutation cannot be reconciled, surface `unknown` and require
  user review; never hide it to complete rollout.
- Profile deletion remains a separate explicit user decision after migration.
