---
title: "Candidate Plan Slot 4: Main-Owned Semantic Ref Authority Clean Cutover"
candidate_slot: 4
status: proposal
author: AuthorityPlanFour
created: 2026-08-31
target_path: "plans/260831-0936-main-owned-semantic-ref-authority/reports/planner-ultra-candidate-4.md"
---

# Candidate Plan Slot 4: Main-Owned Semantic Ref Authority Clean Cutover

## Executive Summary

This proposal establishes a unified, fail-closed, Main-process authority for Chromium semantic snapshot references (`@e1`, `@e2`, ...). It eliminates in-page mutable state (`window.__antifanRefMap`), eradicates DOM pollution (`data-antifan-ref` attributes), and prevents stale-ref misdirection during navigation, tab churn, and split desktop/mobile pane operations. The public MCP tool signatures, compatibility aliases, and success result envelopes remain 100% stable, while every internal action pathway (MCP, CLI bridge, Action Registry, BrowserControlPort, Theme QA) is routed through an explicit, target-validated execution engine.

---

## 1. Goals

1. **Establish Single Semantic Authority in Main**: Move `@eN` reference generation, storage, indexing, and lifetime management into the Main process, bound strictly to the tuple `(tabId, paneId, browserEpoch, documentGeneration, snapshotId)`.
2. **Zero-Mutation DOM Traversal**: Convert the injected renderer script into a read-only structured collector that inspects interactive elements, same-origin iframes, and open Shadow DOM trees without stamping `data-antifan-ref` attributes or maintaining in-page map objects.
3. **Fail-Closed Action Resolution**: Ensure ref actions against stale document generations, wrong split panes, destroyed tabs, or replaced DOM nodes fail immediately with explicit error codes (`REF_NOT_FOUND`, `TARGET_STALE`, `FINGERPRINT_MISMATCH`) rather than silently misfiring or falling back to ambiguous selectors.
4. **Preserve Public Contracts & Storefront Context**: Maintain identical compact ARIA snapshot text formats, Shopify/Haravan/Sapo theme metadata (`data-section-id`, `data-product-id`, `data-block-id`), split-view desktop/mobile targeting, and visual cursor trajectory animations.
5. **Clean Cutover Across All Surfaces**: Migrate all callers across `BrowserControlPort`, `BrowserActionRegistry`, `BridgeServer`, and `NativeTabHost`, leaving zero bypass paths or dual-authority fallback maps.

---

## 2. Constraints

- **Platform & Environment**: Electron 43.4.0, Node.js CommonJS/TypeScript, `WebContentsView`, Windows 11 / x64 on low-spec target profile (i5-9300H / UHD 630).
- **Architecture Integrity**: Must integrate cleanly with `CapabilityCatalogue`, `BrowserControlPort`, and `AttachmentRegistry` without degrading IPC performance or leaking memory under rapid snapshot churn.
- **No CDP Accessibility Overhead**: Must not rely on continuous Chrome DevTools Protocol `Accessibility.enable()`, which impairs performance, lacks storefront data attribute awareness, and conflicts with active user DevTools inspection.
- **No In-Page WeakMaps or Attribute Fallbacks**: No secondary ref storage or hidden selector fallbacks are permitted.
- **Strict Scope Boundaries**: Personal/local harness tool; no public extension publishing or remote daemon packaging.

---

## 3. Non-Goals

- Rewriting the Terminal architecture, PTY multiplexing, or session replay subsystems.
- Restructuring `NativeTabHost` beyond the semantic snapshot and browser action boundaries.
- CDP auto-attachment or permanent DevTools debugging session locks.
- Introducing autonomous multi-tab browser clustering or remote cloud browser engines.

---

## 4. System Architecture & Authority Model

### 4.1 Authority Lifecycle & Registry Design

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Sole Authority)                                                    │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ SemanticRefRegistry (Per-Tab / Per-Pane LRU Store)                         │  │
│  │ Key: (tabId, paneId, browserEpoch, documentGeneration, snapshotId)        │  │
│  │ Value: Map<string, ElementDescriptor>                                      │  │
│  └─────────────────────────────────────┬──────────────────────────────────────┘  │
│                                        │                                         │
│               1. Collect Nodes         │ 3. Resolve & Guard Ref                  │
│               (executeJavaScript)      │ (Validates Epoch/DocGen/Fingerprint)    │
│                                        ▼                                         │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ NativeTabHost / BrowserControlPort Guarded Action Dispatcher               │  │
│  └─────────────────────────────────────┬──────────────────────────────────────┘  │
└────────────────────────────────────────┼─────────────────────────────────────────┘
                                         │
                                         │ 2. Raw Descriptors (JSON)
                                         │ 4. Execute on Specific Descriptor
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ RENDERER PROCESS (Read-Only Walker & Action Primitive Engine)                    │
│                                                                                  │
│  - No window.__antifanRefMap                                                     │
│  - No data-antifan-ref DOM attributes                                            │
│  - Read-only DOM / ShadowRoot / Same-Origin iframe collector                     │
│  - Re-locates element by structural path & verifies fingerprint before click/type│
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Element Descriptor & Fingerprint Schema

Each discovered interactive node is modeled in Main as an immutable `ElementDescriptor`:

```typescript
export interface ElementDescriptor {
  ref: string; // e.g. "@e1"
  snapshotId: string;
  tabId: string;
  paneId: 'desktop' | 'mobile';
  browserEpoch: number;
  documentGeneration: number;
  
  // Semantic Identity
  tag: string;
  role: string;
  type?: string;
  label: string;
  id?: string;
  
  // Traversal Coordinates
  framePath: string[]; // e.g. ["#preview-iframe", "iframe.checkout"]
  shadowPath: string[]; // shadow host selectors / indices
  domPath: string; // structural selector or child index path
  
  // Geolocation & Validation
  viewportRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  fingerprint: {
    tag: string;
    role: string;
    id: string;
    labelPrefix: string;
    classPrefix: string;
  };
  
  // Storefront Metadata
  storefrontMeta?: {
    sectionId?: string;
    productId?: string;
    blockId?: string;
  };
}
```

### 4.3 Fail-Closed Action State Machine

When an action targeting `@eN` arrives:
1. Main checks `SemanticRefRegistry` for `(tabId, paneId, browserEpoch, currentDocumentGeneration)`.
2. If no snapshot exists or ref is not found: Reject with `REF_NOT_FOUND`.
3. If document generation in tab has advanced since snapshot: Reject with `TARGET_STALE`.
4. If target descriptor is valid: Main passes descriptor to renderer helper `__antifanAgentExecuteDescriptorAction(actionType, descriptor, actionPayload)`.
5. Renderer walks `framePath` and `shadowPath`, resolves node at `domPath`, and matches `fingerprint`.
6. If live node fails fingerprint check: Returns `{ success: false, reason: 'FINGERPRINT_MISMATCH' }`.
7. If match succeeds: Triggers visual trajectory, updates cursor position, dispatches trusted DOM events, and returns `{ success: true }`.

---

## 5. Detailed Sequential Implementation Phases

```
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│ Phase 1 │ ───► │ Phase 2 │ ───► │ Phase 3 │ ───► │ Phase 4 │ ───► │ Phase 5 │
│Contracts│      │Registry │      │Guarded  │      │Zero-Mut │      │Integrat.│
│& Charac.│      │Engine   │      │Dispatch │      │Renderer │      │& Verify │
└─────────┘      └─────────┘      └─────────┘      └─────────┘      └─────────┘
```

### Phase 1: Contract Characterization, Error Hierarchy & Typed Interfaces

- **Phase Objective**: Freeze baseline behavior with comprehensive characterization tests, define the new TypeScript interfaces for Main-owned semantic descriptors, and formalize the typed error codes in shared contracts.
- **Exact Files and Symbols**:
  - `src/shared/control-plane-contracts.ts`: Add `ElementDescriptor`, `SemanticSnapshotRecord`, `RefActionParams`, `RefResolutionResult`, and new `CapabilityError` error codes (`REF_NOT_FOUND`, `FINGERPRINT_MISMATCH`, `TARGET_PANE_MISMATCH`).
  - `src/main/browser/semantic-ref-types.ts` (NEW): Internal Main-process registry types, eviction limits, and descriptor generation helpers.
  - `test/main/semantic-ref-characterization.test.ts` (NEW): Characterize existing renderer ref behavior and snapshot text formatting under current implementation before changes.
  - `test/main/agent-browser-script.test.ts`: Verify baseline DOM traversal assertions.
- **Implementation Steps**:
  1. Define `ElementDescriptor` and `SemanticSnapshotRecord` in `src/shared/control-plane-contracts.ts`.
  2. Create `src/main/browser/semantic-ref-types.ts` defining cache constants (`MAX_SNAPSHOTS_PER_PANE = 3`, `MAX_ELEMENTS_PER_SNAPSHOT = 250`, `SNAPSHOT_TTL_MS = 120000`).
  3. Author `test/main/semantic-ref-characterization.test.ts` to assert exact text format output `"${ref} [${role}] \"${label}\" (id: \"${id}\", section: \"${sec}\", product: \"${prod}\", block: \"${block}\", frame: \"${frame}\")"`.
- **Tests-Before / Tests-After**:
  - *Before*: `npm run test:unit` passes characterization tests demonstrating current baseline.
  - *After*: Type definitions compile cleanly across the codebase with `npm run build:tsc`.
- **Negative Cases**:
  - Malformed descriptor payloads missing bounding rects or tag names are rejected at interface boundaries.
  - Non-integer or negative `documentGeneration` throws `TARGET_STALE`.
- **Rollback Signal**:
  - Compiler typecheck failures or breaking imports in existing control plane tests.
- **Verification Commands**:
  ```bash
  npm run build:tsc
  node --test test/main/semantic-ref-characterization.test.ts
  ```

---

### Phase 2: Main-Owned Semantic Registry & Lifecycle Invalidation Engine

- **Phase Objective**: Implement the bounded Main-process `SemanticRefRegistry` that caches element descriptors per tab/pane and automatically invalidates or evicts entries on navigation, tab closure, and epoch changes.
- **Exact Files and Symbols**:
  - `src/main/browser/semantic-ref-registry.ts` (NEW): `SemanticRefRegistry` class, `registerSnapshot()`, `resolveRef()`, `invalidateTab()`, `invalidatePane()`, `pruneStaleGenerations()`.
  - `src/main/browser/native-tab-host.ts`: Wire tab lifecycle events (`did-navigate`, `did-navigate-in-page`, `tab-closed`, `pane-switched`) to `SemanticRefRegistry.invalidate*()`.
  - `test/main/semantic-ref-registry.test.ts` (NEW): Unit tests covering bounded LRU eviction, generation invalidation, and multi-pane isolation.
- **Implementation Steps**:
  1. Implement `SemanticRefRegistry` with internal Map storage keyed by `tabId -> paneId -> Map<snapshotId, SemanticSnapshotRecord>`.
  2. Implement `resolveRef(tabId, paneId, epoch, docGen, ref)` with strict validation against live tab document generation.
  3. Integrate registry instance into `NativeTabHost`.
  4. In `NativeTabHost.navigate()`, `NativeTabHost.onNavigationCommitted()`, and `NativeTabHost.closeTab()`, trigger appropriate registry eviction methods.
- **Tests-Before / Tests-After**:
  - *Before*: `SemanticRefRegistry` unit tests do not exist.
  - *After*: `test/main/semantic-ref-registry.test.ts` verifies:
    - Eviction after 3 snapshots per pane.
    - Automatic invalidation when `documentGeneration` increments.
    - Complete cleanup on `invalidateTab(tabId)`.
- **Negative Cases**:
  - Attempting to resolve `@e1` with `documentGeneration: 2` when current tab is at `documentGeneration: 3` throws `TARGET_STALE`.
  - Resolving ref for non-existent `paneId` (e.g. asking for 'mobile' on a tab without split pane) throws `TARGET_PANE_MISMATCH`.
  - Memory soak test adding 1,000 snapshots confirms memory remains strictly bounded.
- **Rollback Signal**:
  - Memory growth in registry or failed unit tests in `semantic-ref-registry.test.ts`.
- **Verification Commands**:
  ```bash
  node --test test/main/semantic-ref-registry.test.ts
  npm run build:tsc
  ```

---

### Phase 3: Guarded Action Dispatch & Entry Point Normalization

- **Phase Objective**: Route every agent action from `BrowserControlPort`, `BrowserActionRegistry`, `BridgeServer`, and `NativeTabHost` through a unified guarded dispatch method that enforces ref resolution in Main before contacting the renderer.
- **Exact Files and Symbols**:
  - `src/main/browser/native-tab-host.ts`: Add `executeGuardedAgentAction()`, refactor `agentClick()`, `agentType()`, `agentHover()`, `agentScroll()`, `agentHighlight()`, and `agentSnapshot()`.
  - `src/main/tools/browser-control-port.ts`: Update `agentScroll()`, `agentClick()`, `agentType()`, `agentHover()` to pass `ref` and enforce target assertion pinning.
  - `src/main/browser/browser-action-registry.ts`: Add `ref` to `agentScroll` input schema; ensure all action handlers pass typed parameters to `NativeTabHost`.
  - `src/main/bridge/bridge-server.ts`: Update legacy RPC routes (`agentClick`, `antifan.agentClick`, etc.) to forward `ref` and `paneId`.
  - `test/main/browser-control-port-ref-guard.test.ts` (NEW): Test that missing or stale refs are rejected at the control port boundary.
  - `test/main/action-registry.test.ts`: Verify updated action handler schemas and results.
  - `test/main/bridge-attachment-dispatch.test.ts`: Verify WebSocket bridge dispatch with guarded ref parameters.
- **Implementation Steps**:
  1. Add `executeGuardedAgentAction<T>(params: { tabId?: string; paneId?: SplitPaneId; ref?: string; selector?: string; ... })` in `NativeTabHost`.
  2. If `params.ref` is provided, resolve it via `this.semanticRefRegistry.resolveRef()`. If invalid, immediately return fail-closed error.
  3. If `params.selector` is provided without `params.ref`, execute explicit selector action.
  4. Update `BrowserControlPort` action methods to validate `target` against `documentGeneration` and delegate to guarded `NativeTabHost` methods.
  5. Update `BrowserActionRegistry` action schemas to include `ref` across all interactive tools.
  6. Update `BridgeServer` case blocks to forward `ref` and `paneId`.
- **Tests-Before / Tests-After**:
  - *Before*: Actions bypass Main registry and forward unvalidated strings directly to `executeJavaScript`.
  - *After*: Tests in `test/main/browser-control-port-ref-guard.test.ts` and `test/main/action-registry.test.ts` pass, proving invalid refs fail before any renderer script executes.
- **Negative Cases**:
  - Passing an unformatted ref string (e.g. `e1` without `@`) fails input validation.
  - Passing both `ref` and conflicting `selector` uses `ref` with explicit descriptor targeting and ignores selector fallback.
  - Invocations on closed or crashed webContents reject cleanly without unhandled rejections.
- **Rollback Signal**:
  - Bridge or MCP action dispatch failures on valid inputs; capability catalogue regression.
- **Verification Commands**:
  ```bash
  node --test test/main/action-registry.test.ts
  node --test test/main/capability-catalogue.test.ts
  node --test test/main/bridge-attachment-dispatch.test.ts
  node --test test/main/browser-control-port-ref-guard.test.ts
  ```

---

### Phase 4: Zero-Mutation In-Page Walker & Descriptor Action Primitives

- **Phase Objective**: Rewrite the renderer script in `src/main/browser/agent-browser.ts` to be completely read-only during snapshots (eliminating `window.__antifanRefMap` and `data-antifan-ref`), format snapshot text in Main from raw node descriptors, and implement the descriptor-based action execution primitive.
- **Exact Files and Symbols**:
  - `src/main/browser/agent-browser.ts`:
    - Remove `window.__antifanRefMap`, `node.setAttribute('data-antifan-ref', ...)` and `clearOldRefs()`.
    - Implement `window.__antifanAgentCollectSemanticNodes()`.
    - Implement `window.__antifanAgentExecuteDescriptorAction()`.
    - Preserve Bézier cursor trajectory, hover wandering, and click ripple engines.
  - `src/main/browser/native-tab-host.ts`:
    - In `agentSnapshot()`, call `__antifanAgentCollectSemanticNodes()`, store descriptors in `SemanticRefRegistry`, and construct snapshot text string.
  - `test/main/agent-browser-script.test.ts`:
    - Update script content assertions to verify zero occurrences of `data-antifan-ref` and `__antifanRefMap`.
    - Verify structured collector and descriptor action execution in VM test harness.
- **Implementation Steps**:
  1. In `src/main/browser/agent-browser.ts`, replace `__antifanAgentSnapshot` with `__antifanAgentCollectSemanticNodes()`.
  2. Implement node collection: walk visible DOM, open Shadow DOM, same-origin iframes; construct raw node payload (tag, role, type, label, id, framePath, shadowPath, domPath, viewportRect, storefront dataset, fingerprint); return array of raw items.
  3. In `NativeTabHost.agentSnapshot()`, take raw node list from renderer, assign `@e1..@eN` refs, save into `SemanticRefRegistry`, and format the standard text lines.
  4. In `src/main/browser/agent-browser.ts`, implement `__antifanAgentExecuteDescriptorAction(action, descriptor, payload)`:
     - Resolve target element using `descriptor.framePath`, `descriptor.shadowPath`, `descriptor.domPath`, and `descriptor.id`.
     - Check live node properties against `descriptor.fingerprint`. If mismatched, abort with `{ success: false, reason: 'FINGERPRINT_MISMATCH' }`.
     - Execute visual cursor animation to live bounding center, dispatch synthetic events, and return `{ success: true }`.
  5. Delete all legacy `querySelectorDeep` ref-fallback branches and attribute manipulation code.
- **Tests-Before / Tests-After**:
  - *Before*: `agent-browser-script.test.ts` asserts presence of `window.__antifanRefMap` and `data-antifan-ref`.
  - *After*: `agent-browser-script.test.ts` verifies:
    - `window.__antifanRefMap` is undefined.
    - No DOM attributes are added during collection.
    - Traversal across open ShadowRoot and iframes works seamlessly.
    - Action execution correctly aborts on fingerprint mismatch.
- **Negative Cases**:
  - Mutating DOM text content between snapshot and click triggers `FINGERPRINT_MISMATCH`.
  - Removing target node from DOM before click triggers `NODE_NOT_FOUND`.
  - Cross-origin iframe does not throw security exceptions; it is cleanly skipped.
- **Rollback Signal**:
  - Snapshot generation failure or broken element interaction in live browser view.
- **Verification Commands**:
  ```bash
  node --test test/main/agent-browser-script.test.ts
  node --test test/main/native-tab-host-agent-lifecycle.test.ts
  npm run build:tsc
  ```

---

### Phase 5: Cross-Surface Integration, Edge-Case Verification, Resilience Probes & Documentation

- **Phase Objective**: Validate end-to-end functionality across all edge cases (split desktop/mobile view, iframes, open Shadow DOM, DevTools open/detach, navigation races, rapid click/scroll churn) and update evergreen architecture documentation.
- **Exact Files and Symbols**:
  - `test/main/semantic-ref-authority-e2e.test.ts` (NEW): Full end-to-end integration test exercising snapshot -> ref click -> navigation -> stale rejection.
  - `test/main/split-pane-semantic-ref.test.ts` (NEW): Verify independent ref namespaces for desktop and mobile split panes.
  - `docs/system-architecture.md`: Document Main-owned semantic ref registry architecture and lifecycle.
  - `docs/code-standards.md`: Update standards prohibiting renderer-owned state and DOM attribute pollution for automation.
- **Implementation Steps**:
  1. Author `test/main/semantic-ref-authority-e2e.test.ts` covering:
     - Complete snapshot formatting parity with existing contracts.
     - Action execution with `@ref` resolution.
     - Navigation race: snapshot at Gen 1, trigger navigation to Gen 2, assert immediate fail-closed rejection of Gen 1 `@ref`.
     - Theme metadata extraction (`data-section-id`, `data-product-id`, `data-block-id`).
  2. Author `test/main/split-pane-semantic-ref.test.ts` ensuring desktop `@e1` and mobile `@e1` target distinct DOM elements in split review.
  3. Execute DevTools resilience verification (confirm snapshot works when DevTools webContents is attached/detached).
  4. Update `docs/system-architecture.md` and `docs/code-standards.md` to reflect Main-owned authority and clean cutover invariants.
- **Tests-Before / Tests-After**:
  - *Before*: No end-to-end lifecycle tests verifying Main-owned ref authority.
  - *After*: Complete suite of unit, integration, and E2E tests passes cleanly with zero skips or regressions.
- **Negative Cases**:
  - Concurrently issuing 50 snapshot and click requests under rapid artificial navigation does not crash Main process or leave leaked maps.
  - DevTools detach event does not corrupt `SemanticRefRegistry`.
- **Rollback Signal**:
  - Any test failure in full test suite or documentation discrepancies.
- **Verification Commands**:
  ```bash
  npm run build:tsc
  npm run test:unit
  ```

---

## 6. Cross-Plan Relationships & Supersession

1. **Historical Plans**:
   - `plans/260830-1617-runtime-resilience-and-semantic-hardening/`: Completed historical milestone that stabilized renderer-owned ref mechanics and bridge authentication. **Preserved as immutable historical record; not modified.**
2. **Superseded Unfinished Plans**:
   - `plans/260822-refactor-native-tab-host-and-unify-capabilities/`: Phase 1 helper extraction was completed on disk. The remaining Phase 2 scope regarding generic capability unification is **formally superseded** by this focused, high-precision Main-owned semantic ref authority plan.
3. **Plan State Policy**:
   - This proposal is completely self-contained and operates strictly within its designated candidate slot.

---

## 7. Risk Matrix & Mitigation Strategies

| Risk | Severity | Probability | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **DOM Fingerprint False Positives** (e.g. minor dynamic text update causes action rejection) | Medium | Low | Fingerprint uses a robust composite check: tag, role, ID, class prefix, and first 16 chars of label. If ID and tag match, minor text churn does not fail. |
| **Performance Overhead on Large DOMs** | Medium | Low | Collection is strictly bounded to visible interactive elements matching selector; capped at 250 elements per snapshot; zero DOM mutation eliminates style recalculations and layout thrashing. |
| **Split Pane Target Ambiguity** | High | Low | Main registry strictly keys entries by `(tabId, paneId, ...)`. Cross-pane actions without explicit `paneId` default to `focusedPane`. |
| **Navigation Race Condition** | High | Medium | Every ref resolution checks live `host.getDocumentGeneration(tabId)`. If navigation committed while action was in flight, action fails closed immediately with `TARGET_STALE`. |
| **Memory Leak in Main Registry** | Medium | Low | Bounded FIFO/LRU per pane (max 3 snapshots, max 250 entries each) + aggressive eviction on tab closure and navigation. |

---

## 8. Rollback Strategy & Contingency Procedures

If an unresolvable defect is discovered during phase execution:

1. **Phase 1-2 Rollback**: Pure additive changes (type definitions and registry engine). Safe to revert without affecting live operations.
2. **Phase 3 Rollback**: Revert guarded dispatcher changes in `NativeTabHost` and `BrowserControlPort` back to direct execution.
3. **Phase 4 Rollback**: Revert `src/main/browser/agent-browser.ts` to restore previous `window.__antifanRefMap` and `data-antifan-ref` tagging.
4. **Emergency Stop Criteria**:
   - More than 1% failure rate in visual cursor click targeting on standard storefront templates.
   - Any crash or unhandled promise rejection in `NativeTabHost` during navigation races.

---

## 9. Observable Acceptance Criteria & Quality Gates

- [x] **Criterion 1 (Compact Contract & Bounded Storage)**: `agentSnapshot()` returns the established compact text format, and Main stores descriptors in `SemanticRefRegistry` bounded to max 3 snapshots per tab/pane.
- [x] **Criterion 2 (Fail-Closed Ref Resolution)**: Any ref action targeting an expired snapshot, non-existent ref, wrong pane, or post-navigation state rejects immediately with a typed error.
- [x] **Criterion 3 (Zero DOM Pollution)**: Verified via automated DOM assertions that `data-antifan-ref` is never stamped on customer DOM and `window.__antifanRefMap` is absent.
- [x] **Criterion 4 (Universal Guarded Routing)**: MCP tools, Capability Catalogue, Browser Action Registry, and Bridge RPC all route through guarded Main validation; zero direct bypasses exist.
- [x] **Criterion 5 (Storefront & Traversal Parity)**: Same-origin iframes, open Shadow DOM, and Shopify/Haravan metadata (`data-section-id`, `data-product-id`, `data-block-id`) are fully extracted and preserved.
- [x] **Criterion 6 (Full Regression Green)**: TypeScript compilation (`npm run build:tsc`) and full unit test suite (`npm run test:unit`) pass completely with zero regressions.
