---
phase: 3
title: "Unify Guarded Agent Action Routing"
status: pending
priority: P1
effort: "2d"
dependencies: [2]
---

# Phase 3: Unify Guarded Agent Action Routing

## Overview

Normalize snapshot/action parameters and converge MCP, capability, action registry, bridge, IPC, trajectory, and split-review callers on one Main guarded dispatcher. No caller may bypass target/ref validation.

## Requirements

- Preserve public names, aliases, optional tab/pane targeting, and success envelopes.
- Align missing `ref` support for type/hover/move/scroll/highlight/trajectory where public schemas advertise semantic actions; add `paneId` to trajectory across every transport.
- Resolve refs in Main before isolated-world execution; invalid ref plus selector/coordinates still fails closed.
- Semantic-ref actions execute inside the same exact-target FIFO as collection and hold the queue through isolated executor completion; selector/coordinate modes remain separate explicit modes.
- External capability routes retain lease/grant/attachment checks. Trusted local routes capture an explicit current `BrowserTarget` and concrete pane and share the dispatcher; never counterfeit external auth.
- Attachment refresh remains compatible; registry generation and nonce control semantic refs.

## Architecture

One typed `dispatchAgentAction(target, pane, action, params)` boundary owns resolution and invocation. Omitted pane is normalized once before queue-key creation. Ref mode enters the exact-target FIFO, then captures/rechecks WebContents identity, epoch, pane generation, exact collected URL, descriptor, and nonce. It ensures the versioned module in world `1004`, strictly rejects undefined/malformed results, and rechecks all identity fields before agent-working/glow. It holds the queue until executor completion, so collection cannot rotate nonce mid-action; any full/in-page/subframe navigation invalidates pane generation, record, and isolated nonce outside the queue. Executor checkpoints verify live `location.href` plus nonce/path/connectivity/fingerprint. Main-detectable failure produces no executor call or visual state; isolated failure returns typed error before irreversible event.

## Related Code Files

| Action | File | Change |
|---|---|---|
| Modify | `src/main/browser/native-tab-host.ts` | Unified dispatcher; current-target capture; `agent*` delegation |
| Modify | `src/main/tools/browser-control-port.ts` | Normalize params/pass exact target |
| Modify | `src/main/tools/browser-capabilities.ts` | Align ref/selector/coordinate/pane schemas |
| Modify | `src/main/browser/browser-action-registry.ts` | Remove unguarded execution path |
| Modify | `src/main/bridge/bridge-server.ts` | Guard legacy RPCs; forward ref/pane |
| Modify | `src/main/mcp/mcp-server.ts` | Schema/result parity |
| Modify | `src/main/index.ts` | Guarded IPC wiring |
| Create | `test/main/guarded-action-dispatch.test.ts` | No-side-effect failure tests |
| Modify | `test/main/action-registry.test.ts` | Alias/schema/envelope parity |
| Modify | `test/main/capability-catalogue.test.ts` | Target/parameter parity |
| Modify | `test/main/bridge-attachment-dispatch.test.ts` | Fresh attachment vs stale ref |
| Modify | `test/main/bridge-server.test.ts` | Legacy compatibility/current target |

## Function and Interface Checklist

- [ ] Current target capture includes WebContents identity, concrete pane, epoch, pane-local generation, and exact URL after queue acquisition.
- [ ] Ref dispatcher holds exact-target FIFO from resolution through executor completion; collection cannot replace nonce mid-action.
- [ ] Post-ensure recheck covers WebContents/epoch/generation/URL/active nonce; undefined/malformed envelopes fail closed.
- [ ] Every executor checkpoint validates current `location.href`; no await between final checkpoint and irreversible event.
- [ ] All `agent*` methods delegate only; legacy wrappers translate typed failures to existing boolean envelopes.
- [ ] Trajectory holds one target queue, accepts `paneId`, and revalidates each step. Full/in-page/subframe navigation halts with accurate count; dynamic workflows take a fresh snapshot.
- [ ] Ref failure never downgrades to selector/coordinates. Main failure never activates agent-working/glow/executor; isolated failure never performs irreversible page event.

## Implementation Steps

1. Add typed action union and common dispatcher using the Phase 2 registry and exact-target FIFO.
2. Enforce mode precedence: ref exclusively; else selector; else finite coordinates; else invalid argument.
3. Normalize tab/pane before queue-key creation; acquire FIFO before reading active ref/nonce.
4. Ensure world-`1004` module; reject undefined/malformed result; recheck WebContents, epoch, pane generation, exact URL, active snapshot, nonce.
5. Start agent-working only after Main preflight; executor checks live URL/nonce/path/connectivity/fingerprint initially and after every await before event.
6. Normalize `ref`, `paneId`, and trajectory forwarding across every primary name/alias/transport, including selector-optional `agent-type`.
7. Route trusted legacy/internal callers through explicit target capture and preserve typed/boolean layers.
8. Replace defect characterization and delete bypass blocks.

## Test Scenario Matrix

| Scenario | Expected result |
|---|---|
| Valid ref | Queue acquired; resolve/ensure/recheck; executor verifies; one page action, old envelope |
| Ref action then collection | Collection waits; action cannot lose its nonce mid-execution |
| Collection then ref action | Action sees newly published snapshot or typed absence after failure |
| Stale ref + valid selector | Typed stale error; selector, agent-working, and visual state untouched |
| Unknown ref + coordinates | `REF_NOT_FOUND`; no coordinate click or glow |
| Selector-only / coordinate-only | Existing explicit mode succeeds without semantic fallback |
| Omitted pane then focus changes | Concrete queued target is stable; old token cannot alias |
| Full navigation during queue/ensure/execute | Generation/context/nonce invalidation and repeated guards stop action |
| In-page SPA/hash/history navigation | Pane generation, exact URL, and nonce checkpoints stop action |
| Subframe navigation, including identical-layout replacement | Pane generation/record/nonce invalidate; old iframe descriptor cannot execute |
| Mobile trajectory | Explicit mobile pane; queue/executor target mobile WebContents |
| Trajectory mutates/navigates | Step-local validation fails or halts with accurate count |

## Success Criteria

- [ ] Every entry point reaches the common dispatcher.
- [ ] No unguarded bridge/action-registry/IPC caller remains.
- [ ] Public names/schemas/envelopes remain compatible.
- [ ] Main-detectable ref failures are typed and cause zero executor calls; executor-detectable failures cause zero page overlay/action side effects.

## Verification

```powershell
npm run compile
node --test .compiled/test/main/guarded-action-dispatch.test.js .compiled/test/main/action-registry.test.js .compiled/test/main/capability-catalogue.test.js .compiled/test/main/bridge-attachment-dispatch.test.js .compiled/test/main/bridge-server.test.js
npm run typecheck
```

## Risk Assessment

- **Legacy auth mismatch:** use trusted target adapter, not fabricated leases.
- **Boolean envelopes hide cause:** typed dispatcher for control-plane callers; legacy convenience wrappers return false without unhandled rejection.
- **Nonce race:** exact-target FIFO spans ref resolution through executor completion; collection invalidates before nonce rotation; every navigation invalidates pane generation/record/nonce outside the queue and is guarded repeatedly.
- **Rollback:** migrate/delete adapters atomically; revert full phase if compatibility tests fail.
