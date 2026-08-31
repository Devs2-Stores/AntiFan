---
phase: 1
title: "Characterize Contracts and Define Semantic Ref Types"
status: pending
priority: P1
effort: "1-2d"
dependencies: []
---

# Phase 1: Characterize Contracts and Define Semantic Ref Types

## Overview

Freeze observable behavior and define JSON-safe descriptor, registry, action, and error contracts. Runtime behavior stays unchanged.

## Requirements

- Preserve exact public tool names, aliases, optional `tabId`/`paneId` behavior, and result envelopes.
- Characterize snapshot format, 60-character labels, 150-element cap, metadata order, iframe/shadow traversal, split panes, and visual action outcomes.
- Prove current defects without enshrining them: renderer authority, DOM tagging, dropped `ref`/`paneId`, direct bypasses, action-side effects before validation, and collection-vs-action nonce races.
- Add semantic errors to existing `CapabilityErrorCode`; never create a parallel taxonomy.
- Specify one host-lifetime monotonic ref counter shared by every tab/pane because public actions carry neither snapshot, collection nonce, nor originating target identity and `tabId`/`paneId` are optional.
- Specify a Main-generated cryptographically opaque collection nonce in fixed isolated world `1004`. It may live only in Main records and that isolated document-local lexical closure—never in customer DOM, attributes, main-world globals, logs, or public snapshot text.

## Architecture

Define `TraversalStep` (`dom | shadow | iframe`), `ElementFingerprint`, `ElementGlobalRect`, `StorefrontMetadata`, `RawElementDescriptor`, `SemanticElementDescriptor`, `SemanticSnapshotRecord`, `RendererActionRequest`, and `RendererActionResponse`. Snapshot/action records include exact target, pane-local generation, exact `documentUrl`, collection sequence, and nonce. Isolated results use strictly validated discriminated envelopes; `undefined` is failure. Cross-renderer contracts are plain JSON. `Map` and operation queues stay Main-local.

## Related Code Files

| Action | File | Symbols |
|---|---|---|
| Create | `src/main/browser/semantic-ref-types.ts` | Types, validators, formatter, bounds |
| Modify | `src/shared/control-plane-contracts.ts` | `REF_STALE`, `REF_NOT_FOUND`, `FINGERPRINT_MISMATCH`, `NODE_DETACHED` |
| Create | `test/main/semantic-ref-contract-characterization.test.ts` | Output/caller/error baseline |
| Modify | `test/main/agent-browser-script.test.ts` | Lock legacy traversal/output before replacement |
| Verify | `test/main/action-registry.test.ts` | Aliases/envelopes |
| Verify | `test/main/capability-catalogue.test.ts` | Target/alias contracts |
| Verify | `test/main/bridge-attachment-dispatch.test.ts` | Attachment refresh remains distinct from ref lifetime |

## Function and Interface Checklist

- [ ] `isSemanticRef()` accepts only `/^@e[1-9]\d*$/`.
- [ ] Formatter escapes line-breaking/control characters and preserves metadata order.
- [ ] Validator rejects non-finite geometry, excessive paths/strings, invalid epoch/generation.
- [ ] Descriptor/fingerprint excludes form values, PII, cookies, and full page text.
- [ ] Collection nonce is fixed-length/bounded, generated with `crypto.randomUUID()` or equivalent CSPRNG, excluded from formatted output/logs, and validator-rejected when absent or malformed.
- [ ] Custom world constant is exactly `1004`; tests reject `0`, `999`, and Chrome extension-reserved IDs.
- [ ] Exact-target operation contract serializes collection and semantic-ref actions; cleanup is successor-safe on success, throw, cancellation, navigation, and teardown.
- [ ] Collision contract is explicit: refs never repeat during the `NativeTabHost` lifetime across tabs, panes, snapshots, eviction, target/focus changes, navigation, tab close/create, epoch changes, or renderer recovery.

## Implementation Steps

1. Fresh-compile and run current focused tests; record failures without weakening them.
2. Add characterization cases for snapshot text, DOM tagging/ref map, and field forwarding.
3. Define JSON-safe contracts and strict validators.
4. Extend the shared error union.
5. Add formatter cases: empty label, Unicode, quotes/newlines, missing metadata, iframe metadata, 150-item cap.
6. Add failing-before regressions: snapshot A assigns `@e1`; a later same-document snapshot, failed collection, collection queued against an action, post-navigation snapshot, other-pane snapshot, other-tab snapshot, and identical-layout main-frame or iframe document replacement must never execute A's token or assign `@e1` to another node.

## Test Scenario Matrix

| Scenario | Expected contract |
|---|---|
| First snapshot for a new host | Starts at `@e1`; current text format preserved; nonce not exposed |
| Later snapshot on same exact target | Queue excludes ref action overlap; new nonce; old descriptors invalidated before scan |
| Collection fails/returns undefined after nonce rotation | No active snapshot; old ref cannot execute |
| Full, in-page, or subframe navigation in one pane | That pane generation/record/nonce invalidates; sibling pane remains valid |
| Renderer crash/recovery under retained tab identity | Pane refs invalidate; host counter continues |
| Malformed descriptor/URL/nonce/result envelope | Typed error; no execution or visual side effect |
| Existing public surfaces | Names, optional-target behavior, and success envelopes unchanged |

## Success Criteria

- [ ] Compatibility and current-defect characterization tests exist.
- [ ] Types serialize without DOM objects/functions/Maps crossing process boundary.
- [ ] Shared errors remain unified.
- [ ] Same-document, post-navigation, cross-pane, and cross-tab stale-ref aliasing are permanent regression tests.

## Verification

```powershell
npm run compile
node --test .compiled/test/main/semantic-ref-contract-characterization.test.js .compiled/test/main/agent-browser-script.test.js .compiled/test/main/action-registry.test.js .compiled/test/main/capability-catalogue.test.js
npm run typecheck
```

## Risk Assessment

- **Enshrining defect:** if a test requires direct bypass, label it defect evidence and replace it in Phase 3.
- **Sensitive fingerprint:** if descriptors capture values/full text, reduce to bounded semantic identity.
- **Rollback:** additive types/tests only; remove if they create dependency cycles.
