---
phase: 4
title: "Remove Renderer Ref Authority and DOM Mutation"
status: pending
priority: P1
effort: "2d"
dependencies: [3]
---

# Phase 4: Remove Renderer Ref Authority and DOM Mutation

## Overview

Replace injected ref state with a read-only structured collector and descriptor-targeted action executor. Delete page attributes, globals, and fallback authority while retaining cursor kinematics.

## Requirements

- Snapshot collection writes nothing to customer DOM and exposes no main-world ref/descriptor/nonce authority; AntiFan overlays appear only after validated execution begins.
- Preserve candidate selector, visibility pruning, 150-item cap, labels, theme metadata, global frame coordinates, same-origin frames, and open shadow roots.
- Structural paths represent DOM/iframe/shadow boundaries; cross-origin/closed-shadow content skips safely.
- Main passes a fresh opaque nonce into fixed isolated world `1004`. Official Electron guidance reserves `999` for preload/context isolation and recommends `1000+`; `1004` is below Chrome extension-reserved `[1 << 20, 1 << 29)`.
- Isolated closure stores current nonce/script version; descriptors/refs stay Main-owned. Collection/executor results use strict envelopes because isolated execution may resolve `undefined` instead of rejecting.
- Descriptor/request includes exact collected `documentUrl`. Executor verifies live `location.href`, nonce, path, connectivity, and fingerprint before scroll/focus/animation/overlay/event and repeats after any await immediately before irreversible event.
- Every full, in-page, or subframe navigation receives a Main-triggered isolated nonce invalidation request; synchronous pane generation/record invalidation remains authoritative if that asynchronous request races.
- Migrate all visual cursor overlays, highlight banners, ambient animation, explicit selector/coordinate execution, scrolling, typing, clearing, and multi-step trajectories into the self-contained module in isolated world `1004` behind the versioned isolated dispatcher. Delete all `window.__antifanRefMap`, `data-antifan-ref`, and main-world `window.__antifanAgent*` globals.

## Architecture

Install the complete agent engine (collector, descriptor executor, visual cursor overlay, banner, highlight, scroll, type, explicit selector/coordinate executor, trajectory runner, and cleanup helpers) through `executeJavaScriptInIsolatedWorld(1004, ...)` with one versioned isolated closure entrypoint. At collection start Main has invalidated old state; isolated collection installs new nonce before scanning and returns strict `{ ok: true, nonce, documentUrl, descriptors }`. Undefined, explicit failure, malformed URL/echo, cancellation, or stale completion publishes nothing. Queued action sends nonce/descriptor/documentUrl; executor rejects unless closure nonce and live `location.href` match, re-traverses recorded contexts, verifies connectivity/fingerprint, computes nested-frame global geometry, and only then uses cursor/action helpers in world `1004`. It repeats checks after awaits with no intervening await before event. Every full/in-page/subframe navigation synchronously invalidates the pane record in Main and requests closure nonce invalidation; in-flight operations abort at their next URL/generation/nonce checkpoint. Main-world scripts cannot observe, tamper with, or replace the isolated closure dispatcher, internal nonces, or descriptors. Because overlay DOM elements exist in the shared document tree and can be observed or removed by page code, they possess zero execution authority; visual helpers self-heal missing overlay nodes idempotently before each visual update.

## Related Code Files

| Action | File | Change |
|---|---|---|
| Modify | `src/main/browser/agent-browser.ts` | Collector/path/fingerprint/executor; remove ref authority |
| Modify | `src/main/browser/native-tab-host.ts` | Register descriptors/dispatch actions |
| Modify | `test/main/agent-browser-script.test.ts` | Zero-mutation/executor assertions |
| Create | `test/main/zero-mutation-walker.test.ts` | Behavioral VM cases |
| Modify | `test/main/native-tab-host-agent-lifecycle.test.ts` | Descriptor execution/navigation guard |
| Modify | `scripts/smoke-split-review.cjs` | Real pane snapshot/action |

## Function and Interface Checklist

- [ ] World constant is exactly `1004`; no use of `0`, `999`, or extension-reserved IDs.
- [ ] Isolated collector installs nonce before scanning and returns strict nonce/URL/descriptors envelope; undefined/malformed/failure never publishes.
- [ ] Paths contain index plus tag/id hints at DOM, shadow, and iframe boundaries.
- [ ] Resolver cannot escape recorded context; nested-frame rects map to top-level viewport coordinates.
- [ ] Executor rejects URL/nonce/path/connectivity/fingerprint failure before irreversible effects; post-await final check has no intervening await.
- [ ] Every navigation invalidates pane generation/record synchronously and isolated nonce asynchronously; URL/generation/nonce checks fail closed independently.
- [ ] All cursor overlays, banner, highlight, ambient animations, scroll, type, clear, explicit selector/coordinate, and trajectory helpers execute exclusively in isolated world `1004`.
- [ ] Legacy `window.__antifanRefMap`, DOM `data-antifan-ref` tags, deep-selector authority, and main-world `window.__antifanAgent*` globals/tests are deleted.

## Implementation Steps

1. Build the versioned isolated module around constant world ID `1004`; strict envelope validators cover success, explicit failure, and `undefined`.
2. Collection installs nonce before scan; walks once and returns bounded descriptors plus exact `location.href` without customer writes.
3. Main invalidates before invocation; only current successful nonce/URL echo reaches publication/text formatting.
4. Resolve structural path; same-context selector hint remains fingerprint-mandatory.
5. Verify exact URL/nonce/connectivity/fingerprint/global geometry before initial effects and after awaited movement immediately before event.
6. Add isolated nonce-invalidation entrypoint used for every full/in-page/subframe navigation; it returns a strict envelope but Main safety does not depend on its success.
7. Migrate cursor DOM injection/styles, highlight overlays, banners, scroll, type, explicit selector/coordinate execution, and multi-step trajectory helpers into the isolated world `1004` script module.
8. Delete all main-world `window.__antifanAgent*` global attachments, `window.__antifanRefMap`, DOM tagging, and obsolete main-world unit tests.
9. Update split smoke for independent panes and mobile trajectory.

## Test Scenario Matrix

| Scenario | Expected result |
|---|---|
| World allocation | Uses `1004`; customer main world and preload world `999` cannot observe dispatcher |
| Main document | Descriptor/text/action parity; nonce absent from main world/output |
| Collection returns undefined/malformed | Main keeps target snapshot invalid; no refs allocated |
| Open shadow root | Boundary path and fingerprint succeed |
| Nested same-origin frame | Frame metadata and top-level global rect preserved |
| Cross-origin/closed shadow | Safe omission |
| Full navigation to identical layout | Generation/context/nonce invalidation rejects old action |
| In-page SPA/hash/history navigation | Exact URL/generation plus isolated nonce invalidation rejects old action |
| Subframe navigation or identical-layout iframe replacement | Entire pane snapshot/generation/nonce invalidates; old descriptor cannot execute |
| Node replaced before/during movement | Initial and post-await fingerprint checks block event before irreversible action |
| Input has customer value | Value absent from descriptor/logs |
| Main-world prototype tampering | Isolated world uses clean realm built-ins; dispatch mechanics execute without hijack |
| Storefront listener event delivery | Page listeners receive synthetic events with standard properties; `preventDefault()` supported |
| Hostile page script modifies/removes overlay DOM | Visual overlays self-heal; action executes safely without crashing or leaking isolated state |
| Customer script watches/spoofs | No ref mutation; cannot access or replace isolated dispatcher |
| DevTools open | Snapshot/action works without debugger attachment |

## Success Criteria

- [ ] Exactly world `1004`; zero tags/ref map/main-world dispatcher/customer-visible nonce.
- [ ] Same-origin iframe/open-shadow/storefront metadata/global-coordinate parity passes from isolated world.
- [ ] Failed collection leaves no active snapshot; wrong nonce, any navigation, or node replacement fails at the specified side-effect boundary.
- [ ] Cursor, highlight, banner, scroll, type, clear, trajectory, and explicit selector/coordinate modes remain fully functional from isolated world `1004` with complete behavioral parity.

## Verification

```powershell
npm run compile
node --test .compiled/test/main/zero-mutation-walker.test.js .compiled/test/main/agent-browser-script.test.js .compiled/test/main/native-tab-host-agent-lifecycle.test.js
npm run smoke:split
npm run typecheck
```

## Risk Assessment

- **Fingerprint too strict:** remove volatile fields only; never weaken context/tag/role/id safety or add fuzzy fallback.
- **Isolated-world drift:** lock ID `1004`/version, cite Electron `1000+` guidance, reject `undefined`, and test main-world/preload spoofing.
- **Traversal cost:** single pass, compact numeric steps, 150-item cap; no AX cache.
- **Rollback:** revert the entire authority cutover; never ship dual Main/renderer ref fallback.
