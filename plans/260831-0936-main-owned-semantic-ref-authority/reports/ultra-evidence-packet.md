---
title: "Ultra Evidence Packet: Main-Owned Semantic Ref Authority"
status: final
created: 2026-08-31
---

# Ultra Evidence Packet: Main-Owned Semantic Ref Authority

## Requested Outcome

Deeply analyze Orca/Onorca patterns and AntiFan's Chromium/Terminal runtime, then produce a load-bearing implementation plan for the highest-value remaining improvement. Current research converged on a Chromium clean cutover: semantic snapshot refs and their lifecycle become Main-process authority, without losing AntiFan's storefront metadata, split-view targeting, visible cursor, or public browser tool names/result envelopes.

## Brainstorm Contract

### Outcome

One authoritative path maps every `@eN` ref to a structured, read-only element descriptor owned by Main and bound to exact tab, pane, browser epoch, and document generation. Every ref action rejects stale/mismatched descriptors before touching the page. Customer DOM receives no `data-antifan-ref` mutation.

### Constraints

- Electron 43.4.0, TypeScript/CommonJS, `WebContentsView`, current `CapabilityCatalogue`/`BrowserControlPort` architecture.
- Preserve public MCP/capability/action names and success result envelopes; cleanly migrate every in-repo caller and test.
- Preserve same-origin iframe traversal, open Shadow DOM traversal, storefront `data-section-id`/`data-product-id`/`data-block-id`, split desktop/mobile panes, and visual cursor/trajectory behavior.
- No pure CDP Accessibility dependency: it loses custom data attributes, imposes continuous AX cache overhead, and conflicts with an open DevTools debugger session.
- No second ref authority, compatibility ref map, DOM attribute fallback, or hidden selector fallback for stale refs.
- Personal/local tool; no public distribution work.
- Correctness first; low-spec i5-9300H/UHD 630 behavior must remain bounded.

### Non-Goals

- Terminal architecture rewrite; existing PTY/replay/session work is already present and separately planned/implemented.
- Remote SSH, worktree orchestration, public Chrome extension distribution, or new browser product UI.
- Broad `NativeTabHost` decomposition unrelated to semantic/action authority.
- CDP auto-attach or permanent `Accessibility.enable()`.

### Acceptance Criteria

1. Snapshot returns the existing compact text contract and Main stores a bounded structured registry keyed by `(tabId, paneId, browserEpoch, documentGeneration, snapshotId)`.
2. `@ref` action resolution is fail-closed for stale generation, wrong pane/tab, detached/replaced node fingerprint, unknown ref, and navigation during action.
3. Snapshot and ref actions preserve same-origin iframe/open-shadow traversal and storefront metadata with zero `data-antifan-ref` attributes and no `window.__antifanRefMap`.
4. MCP, capability aliases, browser action registry, WebSocket bridge, workflow/Theme QA, split-review smoke, and Main IPC use one guarded action dispatch path or an explicitly target-checked internal adapter; no direct unguarded `NativeTabHost.agent*` bypass remains.
5. Selector and coordinate actions remain available as separate explicit target modes; they never masquerade as successful stale-ref resolution.
6. DevTools-open and debugger-detach states do not break semantic snapshot/actions.
7. Focused contract tests, typecheck, full unit/integration verification, split-view smoke, navigation-race probes, and bounded soak show no regression or registry leak.

## Verified Current Evidence

- `src/main/browser/agent-browser.ts:247-378`: injected script owns `window.__antifanRefMap`, stamps/removes `data-antifan-ref`, walks interactive DOM, same-origin frames, and open shadow roots.
- `src/main/browser/native-tab-host.ts:3465-3585,4768-4795`: host injects script for actions; refs are passed back into renderer; `agentSnapshot` receives only text and stores no ref metadata in Main.
- `src/main/tools/browser-control-port.ts:165-195,250-325`: target resolver exists, but ref parameters are inconsistent and action methods do not independently pin snapshot identity.
- `src/main/browser/browser-action-registry.ts:352-460`: action handlers call `NativeTabHost` directly; scroll schema has no `ref`.
- `src/main/bridge/bridge-server.ts:786-800,1066-1131`: legacy agent RPC routes call `NativeTabHost.agent*` directly and drop `ref`/pane fields.
- `src/main/run/attachment-registry.ts:235-257`: effective browser target may be rewritten to the live document generation. Existing tests intentionally refresh attachment generation after navigation; ref staleness therefore needs its own snapshot-generation authority even if generic attachment semantics stay unchanged.
- `test/main/agent-browser-script.test.ts`, `action-registry.test.ts`, `capability-catalogue.test.ts`, `bridge-attachment-dispatch.test.ts`, `native-tab-host-agent-lifecycle.test.ts`: current contracts and direct paths need characterization before mutation.
- `plans/260830-1617-runtime-resilience-and-semantic-hardening/`: completed plan deliberately implemented renderer-owned refs; it is historical evidence, not a pending plan to edit.
- `plans/260822-refactor-native-tab-host-and-unify-capabilities/`: Phase 1 helper extraction is already present on disk; Phase 2 guarded dispatch is incomplete/stale and should be superseded by this narrower plan.

## Feasibility Decision

Use a read-only in-page structured walker orchestrated by Main. It returns element descriptors, semantic fields, theme metadata, frame/shadow traversal paths, viewport rect, and a fingerprint. Main assigns refs, formats the legacy snapshot text, bounds registry size/lifetime, and validates exact target/snapshot identity. Ref actions send the resolved descriptor to a renderer action primitive that re-traverses the descriptor path and verifies the fingerprint before dispatch. Main is the sole ref authority; renderer code is an execution engine only.

Do not store DOM nodes or CDP `RemoteObjectId`s in Main. Do not keep an in-page WeakMap as a second authority. Do not use pure CSS selectors as the ref identity. Explicit selector actions stay selector actions.

## Required Planning Shape

Five sequential phases:

1. Characterize current contracts and introduce typed descriptor/result/error contracts.
2. Implement bounded Main-owned per-tab/pane/generation registry and lifecycle invalidation.
3. Route every action entry point through exact target/ref validation and normalize parameters.
4. Convert renderer walker/actions to zero-mutation descriptor execution; remove old ref map/attribute/fallback authority.
5. Verify cross-frame/shadow/split/navigation/DevTools behavior, resource bounds, full regression, and update durable docs.

Every phase must name exact files, interfaces/functions, tests before/after, negative cases, rollback signal, and verification commands. Cross-plan relationship must supersede only unfinished capability-unification scope, not completed historical plans.

## Candidate Rubric

Score each 1-20:

1. Faithfulness to the contract and clean-cutover invariant.
2. Evidence grounding and exact file/symbol coverage.
3. Phase dependency correctness and implementability.
4. Failure-mode, race, security, and resource-bound coverage.
5. Verification quality and observable acceptance criteria.
