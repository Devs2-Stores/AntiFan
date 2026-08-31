---
title: "Main-Owned Semantic Ref Authority"
description: "Clean-cut renderer-owned @ref state into one bounded Main-process authority with zero storefront DOM mutation and fail-closed action routing."
status: pending
priority: P1
effort: "8-10d"
tags: [refactor, browser, chromium, mcp, reliability, critical]
blockedBy: []
blocks: []
supersedes: [260822-refactor-native-tab-host-and-unify-capabilities]
created: 2026-08-31
---

# Main-Owned Semantic Ref Authority

## Overview

Move semantic `@eN` assignment, storage, invalidation, and resolution from page globals into Electron Main. Keep the renderer as a read-only semantic collector and fingerprint-verified action executor. Preserve public MCP/capability names, compact snapshot text, storefront metadata, split panes, and visible cursor behavior.

## Contract

- **Outcome:** one Main-owned ref authority keyed by exact target, pane-local document generation, snapshot, and Main-generated collection nonce, using host-lifetime non-reused compact refs shared across every tab and pane.
- **Constraints:** Electron 43.4.0; no permanent CDP AX/debugger dependency; collector/executor use fixed custom isolated-world ID `1004` (`1000+`, below Chrome extension-reserved `[1 << 20, 1 << 29)`); zero `data-antifan-ref`; no renderer ref map or customer-DOM/main-world nonce stamp; public success envelopes remain stable.
- **Non-goals:** Terminal rewrite, remote/worktree infrastructure, public distribution, broad `NativeTabHost` decomposition.
- **Acceptance:** collection and semantic-ref actions cannot race the exact target's nonce; failed/stale collection leaves no active snapshot; stale/wrong-pane/document-instance refs fail before agent-working or page side effects; replaced/detached/fingerprint-mismatched nodes fail inside the isolated executor before page overlay/action; all entry points use one guarded path; same-origin iframe/open-shadow/storefront semantics and cursor behavior remain verified.

## Architecture Decision

A read-only collector/executor runs through `webContents.executeJavaScriptInIsolatedWorld()` in fixed custom world `1004`. `NativeTabHost` owns one FIFO operation tail per exact `(tabId, paneId)` and serializes snapshot collection plus semantic-ref actions for that target; unrelated targets remain concurrent. Queue entry captures concrete pane, WebContents identity, epoch, pane generation, and exact `documentUrl`, all rechecked when execution begins. Every navigation start observed for the pane—including full main-frame, `isInPlace=true` hash/history/SPA, and subframe navigation—synchronously bumps only that pane's semantic generation and invalidates its Main record outside the queue. Every navigation also requests isolated nonce invalidation; full main-frame navigation additionally destroys the isolated context. Diagnostics/QA clearing may retain its existing non-in-place authority policy independently.

Main begins collection by invalidating the exact target's active snapshot, then issues a monotonic sequence and cryptographically opaque nonce before the isolated scan. Collection publishes only when strict result shape, nonce echo, WebContents, epoch, pane generation, exact URL, and sequence remain current. Failure, `undefined` isolated result, cancellation, or stale completion leaves that target without an active snapshot and allocates no refs. Queue tails are released in `finally` only if still current, including throw/cancel/teardown paths. The isolated document context stores only script version/current nonce behind a closure dispatcher inaccessible to customer main-world JavaScript.

A queued semantic-ref action resolves against the active Main record, ensures the isolated module in world `1004`, rechecks WebContents/epoch/generation/URL/nonce before agent-working/glow, and occupies the target FIFO queue to prevent concurrent collection from rotating nonces mid-action. Navigation invalidation explicitly occurs outside the queue; in-flight operations do not prevent navigation, but rather their repeated generation/URL/nonce checkpoints at Main and within the isolated executor cleanly abort the operation before any irreversible DOM event or visual side effect. All visual cursor overlays, highlight banners, explicit selector/coordinate actions, scrolling, typing, clearing, and multi-step trajectories migrate fully into the isolated world `1004` module behind the versioned dispatcher, removing all `window.__antifan*` globals from the customer main world. Because overlay elements reside in the shared DOM tree, they hold zero security or execution authority; visual helpers use idempotent self-healing creation before each step, and hostile DOM removal or restyling by page scripts cannot compromise isolated nonce/dispatcher integrity.

## Cross-Plan Dependencies

| Relationship | Plan | Decision |
|---|---|---|
| Historical foundation | `260830-1617-runtime-resilience-and-semantic-hardening` | Keep completed record unchanged; replace only its renderer-owned ref design. |
| Supersedes unfinished scope | `260822-refactor-native-tab-host-and-unify-capabilities` | Keep completed helper extraction; this plan owns guarded agent-action unification and validation. |

## Phases

| # | Phase | Status | Dependency |
| 1 | [Characterize Contracts and Define Types](./phase-01-start.md) | Complete | None |
| 2 | [Build Main Ref Registry](./phase-02-main-ref-registry.md) | Complete | Phase 1 |
| 3 | [Unify Guarded Action Routing](./phase-03-guarded-action-routing.md) | Complete | Phase 2 |
| 4 | [Remove Renderer Ref Authority](./phase-04-renderer-authority-removal.md) | Complete | Phase 3 |
| 5 | [Integrate, Race-Test, and Soak](./phase-05-integration-and-soak-verification.md) | Complete | Phase 4 |
## Ultra Selection

Mechanical eligibility ran before qualitative verification: every `npm run` name had to exist in `package.json`, and every direct test command had to target compiled JavaScript under `.compiled`. Candidates 1, 4, and 5 were rejected before scoring; verifier rank contains only eligible unchanged candidates.

| Verifier rank | Anonymous candidate | Score | Result |
|---|---|---:|---|
| 1 | A (source candidate 3) | 99/100 | Selected unchanged as architecture baseline |
| 2 | D (source candidate 2) | 96/100 | Rejected by verifier |

| Ineligible candidate | Mechanical rejection |
|---|---|
| Source candidate 1 | References undefined `build:ts` package script |
| Source candidate 4 | Uses nonexistent `build:tsc`/`test:unit` and raw TypeScript tests |
| Source candidate 5 | Invokes raw TypeScript tests instead of `.compiled` JavaScript |

Post-selection canonical corrections were applied only after the unchanged winner was selected: fresh `npm run compile` before focused `.compiled` tests; host-lifetime global refs; one exact-target FIFO for collection and semantic-ref actions; failed collection invalidation; successor-safe tail cleanup; isolated world `1004`; strict `undefined` rejection; pane-local generation invalidation for full, in-page, and subframe navigation; exact document-URL checks; crash-preserved tab identity; post-injection Main rechecks; post-await executor validation; mobile trajectories; shared semantic error taxonomy.

## Success Criteria

- [ ] No `window.__antifanRefMap`, `data-antifan-ref`, renderer-side ref fallback, main-world `window.__antifanAgent*` globals, or customer-visible nonce stamp remains; all cursor, overlay, scroll, type, highlight, and explicit selector/coordinate helpers operate exclusively within isolated world `1004`.
- [ ] Same-target collection and semantic-ref action ordering is FIFO; failed/stale/cancelled collection leaves no active snapshot; queue tails clean up without deleting successors.
- [ ] Main rejects unknown, evicted, wrong-tab, wrong-pane, stale-generation, wrong-URL, wrong-nonce, malformed/`undefined` isolated results, and full/in-page/subframe navigation races before agent-working/page side effects; isolated execution rejects detached and fingerprint-mismatched nodes before page overlay/action.
- [ ] Snapshot text and storefront/frame metadata remain compatible; target/focus changes, later snapshots, any pane-local navigation, crashes, and new tabs never alias an old ref to a new node.
- [ ] MCP, capability catalogue, action registry, WebSocket bridge, split review, mobile trajectories, and Theme QA have one tested guarded route.
- [ ] Every verification command names an existing `package.json` script or `.compiled` test path; typecheck, focused compiled tests, full `npm test`, freshly compiled split smoke, identical-layout navigation-race probe, DevTools-open probe, and bounded soak pass.

## Unresolved Questions

None. Bounds start conservative and are adjusted only from Phase 5 evidence.

<!-- slug: main-owned-semantic-ref-authority -->
