# Implementation Plan Proposal: Main-Owned Semantic Ref Authority (Candidate 2)

**Document ID**: `plans/260831-0936-main-owned-semantic-ref-authority/reports/planner-ultra-candidate-2.md`  
**Author**: Systems & Reliability Engineering (Candidate 2)  
**Evidence Source**: `plans/260831-0936-main-owned-semantic-ref-authority/reports/ultra-evidence-packet.md`  
**Status**: Proposal  

---

## 1. Executive Summary & Goals

### 1.1 Goal
Architect and execute a clean cutover for AntiFan Browser's semantic ref system, transferring element reference authority (`@e1`, `@e2`, ...) entirely from the renderer DOM into the Electron Main process. Ref identity is bound to a strict tuple: `(tabId, paneId, browserEpoch, documentGeneration, snapshotId)`. 

### 1.2 Core Invariants
1. **Zero Customer DOM Mutation**: Eliminate all `data-antifan-ref` attribute stamping and cleanup passes. Customer DOM is completely immutable during snapshots.
2. **Single Main Authority**: Eliminate `window.__antifanRefMap`. Main assigns refs, formats compact snapshot text, bounds registry memory, and validates descriptor freshness before dispatching actions.
3. **Fail-Closed Stale Ref Action Invariant**: Any action targeting an `@ref` with a mismatched `browserEpoch`, `documentGeneration`, closed tab, wrong split pane, or replaced/detached node fingerprint fails closed immediately with typed errors (`REF_STALE`, `REF_NOT_FOUND`, `NODE_MUTATED_OR_DETACHED`).
4. **Preserved Storefront & Tool Surface**: Retain 100% public MCP tool names (`antifan_agent_snapshot`, `antifan_agent_click`, etc.), result envelope contracts (`{ snapshot, success }`, `{ clicked, success }`), same-origin iframe traversal, open Shadow DOM traversal, storefront meta tags (`section`, `product`, `block`), visual cursor kinematics, and split desktop/mobile pane routing.
5. **No Second Authority / Fallback Masking**: Selector actions and coordinate actions remain separate explicit modes. Stale refs never silently fallback to selector or fuzzy coordinate matching.

---

## 2. Constraints & Non-Goals

### 2.1 Constraints
- **Runtime Environment**: Electron 43.4.0, Node.js CommonJS/TypeScript, `WebContentsView` architecture.
- **Hardware Profile**: Low-spec host budget (Intel i5-9300H / UHD 630 / 16GB RAM). Memory for semantic ref registries must be hard-capped (LRU max 5 snapshots per pane, max 50 snapshots process-wide).
- **Public & Subsystem Contracts**: Public MCP tools, `CapabilityCatalogue`, `BrowserControlPort`, `BrowserActionRegistry`, and Theme QA assertions must continue working without breaking caller schemas.
- **No CDP Accessibility Dependency**: Must not depend on `Accessibility.enable` or continuous CDP AX trees to avoid breaking DevTools debugger attachments and losing custom storefront data attributes (`data-section-id`, `data-product-id`, `data-block-id`).
- **No Backward-Compatibility Fallback**: Clean cutover. No legacy fallback to `window.__antifanRefMap` or `data-antifan-ref`.

### 2.2 Non-Goals
- Terminal PTY / session replay refactoring (handled by dedicated PTY subsystems).
- Remote SSH or Chrome Extension web store packaging.
- Arbitrary monolithic refactoring of `NativeTabHost` outside semantic/action authority boundaries.
- Continuous active background DOM polling or automatic CDP debugger auto-attach.

---

## 3. Architecture & System Design

```
+-------------------------------------------------------------------------------------------------------------------+
|                                                 MAIN PROCESS                                                      |
|                                                                                                                   |
|  +-------------------------------------+      +----------------------------------+                                |
|  |       MCP / Stdio Clients           |      |   WebSocket Bridge / Web GUI     |                                |
|  +-------------------------------------+      +----------------------------------+                                |
|                     \                                     /                                                       |
|                      v                                   v                                                        |
|  +-------------------------------------------------------------------------------+                                |
|  |           CapabilityCatalogue  /  BrowserControlPort (Single Gate)            |                                |
|  |           - Validates Runtime Lease, Project/Workspace ID                     |                                |
|  |           - Resolves exact BrowserTarget (tabId, paneId, epoch, docGen)       |                                |
|  +-------------------------------------------------------------------------------+                                |
|                                         |                                                                         |
|                                         v                                                                         |
|  +-------------------------------------------------------------------------------+                                |
|  |       SemanticRefRegistry (Main-Owned Authority)                              |                                |
|  |       Key: (tabId, paneId, browserEpoch, documentGeneration, snapshotId)      |                                |
|  |       - Assigns @e1..@eN to RawElementDescriptors                             |                                |
|  |       - Stores Map<RefString, ElementDescriptor> with DOM paths & fingerprints|                                |
|  |       - Evicts on navigation, tab close, pane switch, or LRU cap (>5/pane)    |                                |
|  |       - Formats compact text output for agents                                |                                |
|  +-------------------------------------------------------------------------------+                                |
|                     | (Snapshot Query)                          | (Guarded Action Dispatch with Descriptor)       |
|                     v                                           v                                                 |
|  +-------------------------------------------------------------------------------+                                |
|  |       NativeTabHost (WebContents Viewport Controller)                         |                                |
|  |       - Executes injected read-only scanner                                   |                                |
|  |       - Dispatches guarded action with validated descriptor                   |                                |
|  +-------------------------------------------------------------------------------+                                |
+-----------------------------|-------------------------------------------|-----------------------------------------+
                              |                                           |
                              | IPC / executeJavaScript                   | IPC / executeJavaScript
                              v                                           v
+-------------------------------------------------------------------------------------------------------------------+
|                                             RENDERER PROCESS                                                      |
|                                                                                                                   |
|  +---------------------------------------------+     +---------------------------------------------------------+  |
|  |  Read-Only In-Page Walker                   |     |  Descriptor-Targeted Action Primitive                   |  |
|  |  (__antifanScanSemanticElements)            |     |  (__antifanAgentExecuteAction)                          |  |
|  |  - Pure DOM / Shadow / Iframe traversal     |     |  - Resolves exact DOM path & Frame path                 |  |
|  |  - NO data-antifan-ref stamping             |     |  - Verifies node fingerprint (tag, id, role, label)     |  |
|  |  - NO window.__antifanRefMap                |     |  - Executes Cubic Bézier Cursor, Highlight, and Events  |  |
|  |  - Returns RawElementDescriptor[]           |     |  - Fails if node mutated, detached, or displaced        |  |
|  +---------------------------------------------+     +---------------------------------------------------------+  |
+-------------------------------------------------------------------------------------------------------------------+
```

### 3.1 Data Structures & Contracts

```typescript
// src/shared/semantic-contracts.ts (New Shared Contracts)

export type SemanticRef = `@e${number}`;

export interface FramePathSegment {
  frameSelector?: string;
  frameIndex?: number;
  frameId?: string;
}

export interface DomPathSegment {
  tag: string;
  nthIndex: number;
  id?: string;
  className?: string;
}

export interface ElementViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface StorefrontMetadata {
  sectionId?: string;
  productId?: string;
  blockId?: string;
}

export interface RawElementDescriptor {
  role: string;
  tag: string;
  type?: string;
  label: string;
  id?: string;
  storefront: StorefrontMetadata;
  framePath: string;
  domPath: string[];
  rect: ElementViewportRect;
  fingerprint: string;
}

export interface ElementDescriptor extends RawElementDescriptor {
  ref: SemanticRef;
  snapshotId: string;
  tabId: string;
  paneId: 'desktop' | 'mobile';
  browserEpoch: number;
  documentGeneration: number;
  createdAt: number;
}

export interface SemanticSnapshotRecord {
  snapshotId: string;
  tabId: string;
  paneId: 'desktop' | 'mobile';
  browserEpoch: number;
  documentGeneration: number;
  createdAt: number;
  text: string;
  elements: Map<SemanticRef, ElementDescriptor>;
}

export type SemanticActionType = 'click' | 'type' | 'hover' | 'scroll' | 'highlight';

export interface SemanticActionPayload {
  action: SemanticActionType;
  descriptor: RawElementDescriptor;
  text?: string;
  clear?: boolean;
  deltaY?: number;
  label?: string;
}

export interface SemanticActionResult {
  success: boolean;
  action: SemanticActionType;
  executed: boolean;
  error?: string;
  reason?: 'NODE_MUTATED_OR_DETACHED' | 'FRAME_NOT_FOUND' | 'EXECUTION_FAILED' | 'ANIMATION_CANCELLED';
  finalPosition?: { x: number; y: number };
}
```

---

## 4. Five Sequential Implementation Phases

### Phase 1: Characterize Current Contracts & Introduce Typed Authority Contracts

#### 1.1 Objective & Scope
Capture exact baseline behavior of injected scripts, action registry, capability catalogue, and bridge attachments with characterization tests. Define pure TypeScript types and error codes for Main-owned descriptors, snapshots, and action payloads without breaking existing runtime execution.

#### 1.2 Exact Files & Symbols
- **Create**: `src/shared/semantic-contracts.ts`
  - Interfaces: `SemanticRef`, `RawElementDescriptor`, `ElementDescriptor`, `SemanticSnapshotRecord`, `SemanticActionPayload`, `SemanticActionResult`.
  - Error Codes: `REF_STALE`, `REF_NOT_FOUND`, `NODE_MUTATED_OR_DETACHED`, `FRAME_NOT_FOUND`.
- **Modify**: `src/shared/control-plane-contracts.ts`
  - Export new semantic error codes in `CapabilityErrorCode`.
- **Create**: `test/main/semantic-ref-characterization.test.ts`
  - Characterize existing `AGENT_BROWSER_SCRIPT` snapshot generation, `__antifanRefMap` creation, `querySelectorDeep` resolution, and action dispatch paths before modifying any implementation.
- **Inspect / Validate**:
  - `test/main/agent-browser-script.test.ts`
  - `test/main/capability-catalogue.test.ts`
  - `test/main/action-registry.test.ts`
  - `test/main/bridge-attachment-dispatch.test.ts`
  - `test/main/native-tab-host-agent-lifecycle.test.ts`

#### 1.3 Implementation Steps
1. Create `src/shared/semantic-contracts.ts` containing the complete descriptor and snapshot schemas.
2. Extend `CapabilityErrorCode` in `src/shared/control-plane-contracts.ts` to include `'REF_STALE' | 'REF_NOT_FOUND' | 'TARGET_STALE' | 'NODE_MUTATED_OR_DETACHED'`.
3. Add `test/main/semantic-ref-characterization.test.ts` exercising:
   - Traversal of nested same-origin iframes and open shadow roots.
   - Extraction of `data-section-id`, `data-product-id`, `data-block-id`.
   - Compact text formatting (`@e1 [button] "Label" (id: "...")`).
   - Direct execution of `agentClick`, `agentType`, `agentHover`, `agentScroll`, `agentHighlight`.

#### 1.4 Tests Before & After
- **Tests Before**: Run existing unit test suites (`node --test .compiled/test/main/*.test.js`) to establish a clean green baseline.
- **Tests After**: `test/main/semantic-ref-characterization.test.ts` passes, asserting that the new contract types match existing raw properties extracted from the DOM.

#### 1.5 Negative Cases & Edge Conditions
- Malformed ref strings (e.g. `@invalid`, `@e-1`, `null`, `undefined`) must be rejected by contract validators.
- Negative or non-integer epoch/generation in target contracts must throw `TARGET_STALE` or `TARGET_REQUIRED`.

#### 1.6 Rollback Signal & Trigger
- If newly added types cause circular dependency cycles in `src/shared/` or fail compilation in `npm run typecheck`, revert `src/shared/semantic-contracts.ts`.

#### 1.7 Verification Commands
```bash
npm run typecheck
node --test .compiled/test/main/semantic-ref-characterization.test.js
```

---

### Phase 2: Implement Bounded Main-Owned Semantic Ref Registry & Lifecycle Invalidation

#### 2.1 Objective & Scope
Implement `SemanticRefRegistry` in the Main process. It manages element descriptors per `(tabId, paneId, browserEpoch, documentGeneration, snapshotId)` with hard memory limits (LRU per pane) and binds directly to `NativeTabHost` lifecycle events for immediate invalidation upon navigation or tab destruction.

#### 2.2 Exact Files & Symbols
- **Create**: `src/main/browser/semantic-ref-registry.ts`
  - Class: `SemanticRefRegistry`
    - `public registerSnapshot(params: { tabId: string; paneId: 'desktop' | 'mobile'; browserEpoch: number; documentGeneration: number; rawElements: RawElementDescriptor[] }): SemanticSnapshotRecord`
    - `public getDescriptor(params: { tabId: string; paneId?: 'desktop' | 'mobile'; browserEpoch?: number; documentGeneration?: number; ref: string }): ElementDescriptor | null`
    - `public getSnapshotText(tabId: string, paneId?: 'desktop' | 'mobile'): string | null`
    - `public invalidateTab(tabId: string): void`
    - `public invalidateGeneration(tabId: string, paneId: 'desktop' | 'mobile', minGeneration: number): void`
    - `public pruneExpired(maxAgeMs?: number): void`
    - `public formatSnapshotText(elements: RawElementDescriptor[]): { text: string; mapped: Map<SemanticRef, RawElementDescriptor> }`
- **Modify**: `src/main/browser/native-tab-host.ts`
  - Add instance: `private readonly semanticRegistry = new SemanticRefRegistry()`
  - Wire listeners:
    - On tab navigation (`did-start-navigation`, `did-navigate`, `did-navigate-in-page` with generation bump): call `this.semanticRegistry.invalidateGeneration(tabId, paneId, currentDocGen)`
    - On tab close (`closeTab`, `destroy`): call `this.semanticRegistry.invalidateTab(tabId)`
- **Create**: `test/main/semantic-ref-registry.test.ts`

#### 2.3 Implementation Steps
1. Write `SemanticRefRegistry`:
   - Store snapshots in a map: `private readonly store = new Map<string, SemanticSnapshotRecord[]>()` keyed by `${tabId}:${paneId}`.
   - Enforce bounded capacity: max 5 snapshots per pane; process-wide total capped at 50 snapshots.
   - Implement `formatSnapshotText()` in Main to construct the exact compact format string:
     `@eN [role:type] "label" (id: "...", section: "...", product: "...", block: "...", frame: "...")`.
2. Implement descriptor lookup in `SemanticRefRegistry.getDescriptor()`:
   - Check if tab exists.
   - Compare `documentGeneration` and `browserEpoch`. If requested snapshot is older than current tab state -> return `null` (or throw `REF_STALE`).
   - Extract descriptor for ref `@eN`.
3. Hook `SemanticRefRegistry` into `NativeTabHost` navigation event handlers (`webContents.on('did-start-navigation')`, `webContents.on('did-finish-load')`, `updateTabDocumentGeneration()`).
4. Add unit test suite `test/main/semantic-ref-registry.test.ts` verifying registration, formatting, lookup, generation invalidation, and LRU pruning.

#### 2.4 Tests Before & After
- **Tests Before**: `test/main/semantic-ref-characterization.test.ts` passes.
- **Tests After**: `test/main/semantic-ref-registry.test.ts` passes 100%, demonstrating:
  - Strict generation mismatch rejection (`docGen: 1` vs `docGen: 2`).
  - Strict pane separation (descriptor in `desktop` cannot be resolved when querying `mobile`).
  - Automatic eviction when > 5 snapshots are registered for a single tab/pane.

#### 2.5 Negative Cases & Edge Conditions
- Querying a ref on a tab that navigated to a new URL must fail immediately with `null`/`REF_STALE`.
- Rapid successive snapshots on the same page must not leak memory (old snapshot entries evicted from LRU).
- Destroyed tabs must have all associated registry memory wiped cleanly.

#### 2.6 Rollback Signal & Trigger
- Memory leak detected in registry soak test (>5MB retained across 1,000 snapshots) or unit test failures in `test/main/semantic-ref-registry.test.ts`.

#### 2.7 Verification Commands
```bash
npm run typecheck
node --test .compiled/test/main/semantic-ref-registry.test.js
```

---

### Phase 3: Route Action Entry Points Through Guarded Target & Ref Validation

#### 3.1 Objective & Scope
Eliminate all unguarded bypass routes into `NativeTabHost.agent*`. Unify `BrowserControlPort`, `CapabilityCatalogue`, `BrowserActionRegistry`, `BridgeServer`, and internal test callers so that every action request passes through target resolution, lease assertion, and `SemanticRefRegistry` descriptor validation.

#### 3.2 Exact Files & Symbols
- **Modify**: `src/main/tools/browser-control-port.ts`
  - Update methods:
    - `agentClick(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ clicked: boolean }>`
    - `agentType(args: { selector?: string; ref?: string; text: string; clear?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ typed: boolean }>`
    - `agentHover(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ hovered: boolean }>`
    - `agentScroll(args: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ scrolled: boolean }>`
    - `agentHighlight(args: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ highlighted: boolean }>`
    - `agentSnapshot(options?: { tabId?: string; paneId?: 'desktop' | 'mobile' } | string, target?: BrowserTarget): Promise<{ snapshot: string }>`
  - Ensure `resolveTargetTab` and `assertCurrent` are consistently applied across all agent operations.
- **Modify**: `src/main/browser/browser-action-registry.ts`
  - Update action definitions for `agentSnapshot`, `agentClick`, `agentType`, `agentHover`, `agentScroll`, `agentHighlight`:
    - Add `ref` to `agentScroll` and `agentHighlight` input schemas.
    - Forward resolved target and tab parameters to `tabHost` guarded dispatch.
- **Modify**: `src/main/bridge/bridge-server.ts`
  - In `handleClientMessage`, route `agentClick`, `agentType`, `agentScroll`, `agentHover`, `agentHighlight`, `agentSnapshot` through `BrowserControlPort` or guarded `tabHost` methods with explicit `paneId` and target extraction.
- **Modify**: `src/main/browser/native-tab-host.ts`
  - Refactor `agentClick`, `agentType`, `agentHover`, `agentScroll`, `agentHighlight`, `agentSnapshot` to:
    1. Resolve target tab and focused/explicit pane.
    2. Obtain live `browserEpoch` and `documentGeneration`.
    3. If `params.ref` is present: query `this.semanticRegistry.getDescriptor()`. If descriptor missing/stale -> fail closed (return `false` or throw `CapabilityError('REF_STALE')`).
    4. Pass validated `descriptor` directly to renderer execution.
- **Create / Modify**: `test/main/guarded-action-dispatch.test.ts`
- **Update**: `test/main/capability-catalogue.test.ts`, `test/main/action-registry.test.ts`, `test/main/bridge-attachment-dispatch.test.ts`

#### 3.3 Implementation Steps
1. Update `src/main/tools/browser-control-port.ts` to pass `ref` and `paneId` down to `NativeTabHost` with strict target assertion.
2. In `src/main/browser/browser-action-registry.ts`, update `inputSchema` for `agentScroll` and `agentHighlight` to officially support `ref` parameters.
3. In `src/main/bridge/bridge-server.ts`, eliminate raw `this.tabHost.agentClick({ ... })` calls that omit `paneId` or target checks. Map all legacy RPC actions to guarded signatures.
4. In `src/main/browser/native-tab-host.ts`, enforce that when `ref` is supplied:
   - Target generation is checked against the registry.
   - If stale, the action fails closed without executing arbitrary JavaScript on the page.
5. Update `test/main/capability-catalogue.test.ts` and `test/main/action-registry.test.ts` to reflect the guarded contracts.

#### 3.4 Tests Before & After
- **Tests Before**: `test/main/semantic-ref-registry.test.ts` passes.
- **Tests After**: `test/main/guarded-action-dispatch.test.ts` passes, verifying:
  - Invoking `agentClick({ ref: '@e1' })` with an expired document generation returns `{ clicked: false }` or throws `REF_STALE`.
  - Stale refs do NOT fall back to evaluating `@e1` as a CSS selector.
  - Public MCP actions reject invalid target leases and out-of-sync document generations.

#### 3.5 Negative Cases & Edge Conditions
- Calling `agentClick({ ref: '@e999' })` (non-existent ref) must fail immediately with clear telemetry.
- Calling `agentType({ ref: '@e1', text: 'hello' })` after page navigation must fail closed without typing into whatever element happens to be at that index on the new page.
- Direct invocation without required `target` in `BrowserControlPort` must throw `TARGET_REQUIRED`.

#### 3.6 Rollback Signal & Trigger
- Test failures in `test/main/capability-catalogue.test.ts` or `test/main/bridge-attachment-dispatch.test.ts`.

#### 3.7 Verification Commands
```bash
npm run typecheck
node --test .compiled/test/main/guarded-action-dispatch.test.js
node --test .compiled/test/main/capability-catalogue.test.js
node --test .compiled/test/main/action-registry.test.js
```

---

### Phase 4: Zero-Mutation Renderer Walker & Descriptor-Targeted Action Primitive

#### 4.1 Objective & Scope
Refactor `src/main/browser/agent-browser.ts` to:
1. Make `__antifanScanSemanticElements()` completely read-only: no `data-antifan-ref` DOM stamping and no `window.__antifanRefMap`.
2. Implement `__antifanAgentExecuteAction(action, descriptor, options)`: an in-page primitive that resolves the target element via descriptor `domPath` / `framePath` and verifies node fingerprint before performing kinematic cursor movement and event dispatch.
3. Remove all legacy fallback code that searched for `[data-antifan-ref]`.

#### 4.2 Exact Files & Symbols
- **Modify**: `src/main/browser/agent-browser.ts`
  - Remove: `window.__antifanRefMap = new Map()`
  - Remove: `clearOldRefs()` and `node.setAttribute('data-antifan-ref', ...)`
  - Replace `window.__antifanAgentSnapshot` with:
    `window.__antifanScanSemanticElements = (): RawElementDescriptor[] => { ... }`
  - Add: `window.__antifanAgentExecuteAction = async (payload: SemanticActionPayload): Promise<SemanticActionResult> => { ... }`
  - Refactor `window.__antifanAgentClick`, `__antifanAgentType`, `__antifanAgentHover`, `__antifanAgentScroll`, `__antifanAgentHighlight` to accept either:
    - A validated `RawElementDescriptor` (preferred ref path), OR
    - An explicit CSS selector / coordinate tuple (pure selector path, clearly delineated).
  - Add `resolveDescriptorElement(descriptor: RawElementDescriptor): HTMLElement | null` helper with DOM path resolution and fingerprint validation.
- **Modify**: `src/main/browser/native-tab-host.ts`
  - Update `agentSnapshot()`:
    - Calls `__antifanScanSemanticElements()` in renderer to obtain `RawElementDescriptor[]`.
    - Passes `RawElementDescriptor[]` to `this.semanticRegistry.registerSnapshot()`.
    - Returns formatted snapshot text to caller.
  - Update `agentClick`, `agentType`, `agentHover`, `agentScroll`, `agentHighlight`:
    - Dispatch validated `descriptor` to `__antifanAgentExecuteAction()`.
- **Modify**: `test/main/agent-browser-script.test.ts`
  - Update tests to verify zero DOM mutations (no `data-antifan-ref` attributes added or present in DOM after snapshot).
  - Verify `__antifanScanSemanticElements` returns typed `RawElementDescriptor` array.
  - Verify fingerprint mismatch handling.

#### 4.3 Implementation Steps
1. In `src/main/browser/agent-browser.ts`:
   - Replace the snapshot body with a pure functional scanner `__antifanScanSemanticElements`.
   - For each matching visible element, compute `domPath` (array of `tagName:nth-of-type(n)`) and `fingerprint` (hash of tag + id + role + label + framePath).
   - Return plain JavaScript objects `{ role, tag, type, label, id, storefront, framePath, domPath, rect, fingerprint }`.
2. Implement `resolveDescriptorElement(descriptor)`:
   - If `framePath` is present, resolve nested iframe `contentDocument`.
   - Traverse `domPath` or query element.
   - Verify node integrity: `if (node.tagName.toLowerCase() !== descriptor.tag || (descriptor.id && node.id !== descriptor.id)) return null;`
3. Implement `__antifanAgentExecuteAction()`:
   - Resolves target element from descriptor. If not found or fingerprint mismatch -> return `{ success: false, reason: 'NODE_MUTATED_OR_DETACHED' }`.
   - If found -> triggers visual cursor Bézier movement, overlay badge, highlight, and dispatches native-like events (`mousedown`, `mouseup`, `click`, `input`, `change`).
4. Update `NativeTabHost` to orchestrate between `__antifanScanSemanticElements`, `SemanticRefRegistry`, and `__antifanAgentExecuteAction`.
5. Update `test/main/agent-browser-script.test.ts` to assert zero attribute stamping on the DOM.

#### 4.4 Tests Before & After
- **Tests Before**: `test/main/guarded-action-dispatch.test.ts` passes.
- **Tests After**: `test/main/agent-browser-script.test.ts` passes, verifying:
  - `document.querySelectorAll('[data-antifan-ref]').length === 0` at all times.
  - `window.__antifanRefMap` is `undefined`.
  - Same-origin iframes and open Shadow DOM elements are scanned and targeted accurately.
  - Node replacement/mutation mid-action is detected and fails closed with `NODE_MUTATED_OR_DETACHED`.

#### 4.5 Negative Cases & Edge Conditions
- If an element is removed from the DOM between snapshot and click, `resolveDescriptorElement` returns `null` and action returns `{ success: false, reason: 'NODE_MUTATED_OR_DETACHED' }`.
- If an element's text/role changes substantially (fingerprint mismatch), execution aborts cleanly without clicking an unexpected button.
- Same-origin iframe that navigates or becomes cross-origin during action fails safely with `FRAME_NOT_FOUND`.

#### 4.6 Rollback Signal & Trigger
- Visual cursor animation fails or elements in open Shadow DOM / iframes cannot be clicked.

#### 4.7 Verification Commands
```bash
npm run typecheck
node --test .compiled/test/main/agent-browser-script.test.js
node --test .compiled/test/main/native-tab-host-agent-lifecycle.test.js
```

---

### Phase 5: Comprehensive Verification, Cross-Frame/Split-View/DevTools Testing & Documentation

#### 5.1 Objective & Scope
Perform exhaustive end-to-end and vertical-slice validation. Verify split desktop/mobile pane ref isolation, rapid navigation race conditions, DevTools open/detached stability, Theme QA assertions, and memory bounding under continuous soak. Update durable architectural documentation.

#### 5.2 Exact Files & Symbols
- **Create**: `test/main/semantic-ref-integration.test.ts`
  - Full suite testing:
    - Split-view pane isolation (desktop `@e1` vs mobile `@e1` on distinct WebContents).
    - Rapid back-and-forth navigation during snapshot/action sequences.
    - DevTools debugger detachment non-interference.
    - Memory leak soak test (1,000 snapshots with continuous tab creation/destruction).
    - Storefront metadata extraction (`data-section-id`, `data-product-id`, `data-block-id`).
- **Update**: `test/integration/theme-qa-h2s-vertical-slice.test.ts` (if affected by snapshot assertion changes).
- **Update Durable Documentation**:
  - `docs/system-architecture.md` (document Main-owned semantic ref authority, lifecycle rules, and descriptor resolution).
  - `docs/code-standards.md` (record the invariant: zero DOM stamping for automation).

#### 5.3 Implementation Steps
1. Author `test/main/semantic-ref-integration.test.ts` covering split view, navigation races, Shadow DOM, iframes, DevTools, and soak tests.
2. Run full test suite (`npm test`) across all 20+ test files.
3. Run integration vertical slice tests.
4. Update `docs/system-architecture.md` to reflect the Main-owned ref authority architecture and deprecation of in-renderer ref maps.
5. Update `docs/code-standards.md` with explicit guidelines regarding read-only DOM automation.

#### 5.4 Tests Before & After
- **Tests Before**: All phase 1-4 unit tests pass.
- **Tests After**: `npm test` and integration test suite pass with 100% success rate, 0 type errors, and 0 memory leaks.

#### 5.5 Negative Cases & Edge Conditions
- Opening Chrome DevTools on a tab during an active snapshot must not throw or invalidate the snapshot.
- Detaching a debugger must not terminate or reset the `SemanticRefRegistry`.
- Concurrently issuing snapshots on desktop and mobile split panes must keep refs isolated without cross-pane crosstalk.

#### 5.6 Rollback Signal & Trigger
- Test failures in full test suite or integration vertical slices.

#### 5.7 Verification Commands
```bash
npm run typecheck
node --test .compiled/test/main/semantic-ref-integration.test.js
npm test
```

---

## 5. Cross-Plan Relationships & Superseded Scope

### 5.1 Historical Completed Plan (`plans/260830-1617-runtime-resilience-and-semantic-hardening/`)
- **Status**: Completed historical plan.
- **Relationship**: Plan 260830 hardened terminal leases and implemented the initial renderer-owned snapshot scripts. This new plan builds directly on top of that work to advance ref authority into the Main process. It does not reopen, revert, or mutate 260830 records.

### 5.2 Partial Refactoring Plan (`plans/260822-refactor-native-tab-host-and-unify-capabilities/`)
- **Status**: Phase 1 helper extraction is present and operational on disk. Phase 2 (capability unification) is partially implemented and stale.
- **Relationship**: This plan **supersedes** Phase 2 of plan 260822 with respect to browser tool dispatch unification and guarded agent action execution. It achieves clean capability unification specifically for the agent automation and semantic ref tool surface without requiring uncoordinated mega-refactors of unrelated `NativeTabHost` internals.

---

## 6. Risks, Failure Modes & Mitigations

| Risk | Severity | Mitigation Strategy |
| :--- | :--- | :--- |
| **Renderer DOM Mutation Observers Triggered** | High | Pure read-only walker: zero attributes (`data-antifan-ref`) stamped or removed. DOM is never mutated during snapshot. |
| **Stale Ref Action on Navigated Page** | Critical | Main-owned registry validates `documentGeneration` and `browserEpoch` before dispatch. Mismatches fail closed immediately with `REF_STALE`. |
| **Memory Growth from Retained Snapshots** | Medium | Bounded LRU store: maximum 5 snapshots per pane, hard process cap of 50 snapshots. Automatic cleanup on tab destruction and navigation. |
| **DevTools Debugger Conflicts** | High | Zero CDP `Accessibility.enable` dependency. Uses standard isolated script execution that functions identically whether DevTools is open or closed. |
| **SPA Dynamic Content Shifts (Element Displaced)** | Medium | Descriptors store structural `domPath` + `fingerprint` (tag, id, role, label). Renderer action primitive verifies fingerprint before clicking; fails closed if replaced. |
| **Low-Spec CPU Jitter (i5-9300H)** | Low | Renderer scanner is bounded to 150 interactive elements max; traversal skips hidden subtrees (`display: none`, `visibility: hidden`, `opacity: 0`). |

---

## 7. Rollback Strategy

### 7.1 Per-Phase Rollback
- **Phase 1**: Revert `src/shared/semantic-contracts.ts` and `src/shared/control-plane-contracts.ts` diffs.
- **Phase 2**: Remove `SemanticRefRegistry` and unhook navigation listeners from `NativeTabHost`.
- **Phase 3**: Restore previous `BrowserControlPort` and `BrowserActionRegistry` direct call signatures.
- **Phase 4**: Revert `src/main/browser/agent-browser.ts` to the previous `__antifanAgentSnapshot` implementation.
- **Phase 5**: Remove new integration tests and revert docs updates.

### 7.2 Global Rollback Trigger
If end-to-end split view or storefront Theme QA testing exhibits unresolvable regressions in element targeting or visual cursor kinematics that cannot be patched within the phase boundaries, execute clean git rollback of the phase branches before merging.

---

## 8. Verifiable Acceptance Criteria

1. **Compact Snapshot Output Contract**: `agentSnapshot()` returns the exact expected text structure (`@e1 [role:type] "label" (id: "...", section: "...")`) while Main maintains the structured registry keyed by `(tabId, paneId, browserEpoch, documentGeneration, snapshotId)`.
2. **Zero DOM Stamping**: Inspecting live DOM after snapshot shows 0 `data-antifan-ref` attributes and `window.__antifanRefMap === undefined`.
3. **Fail-Closed on Stale Ref**: Invoking `agentClick({ ref: '@e1' })` after `navigateTab` or document generation increment returns `{ clicked: false }` or throws `REF_STALE` without executing clicks on the new page.
4. **Guarded Single Dispatch Path**: `BrowserControlPort`, `CapabilityCatalogue`, `BrowserActionRegistry`, and `BridgeServer` route all ref actions through target assertion and registry validation; no direct unguarded bypass remains.
5. **Delineated Selectors & Coordinates**: Stale refs never fall back to CSS selector evaluation or coordinate guessing. Explicit selector and coordinate actions operate via separate guarded pathways.
6. **DevTools & Split-View Resilience**: Snapshot and ref actions work seamlessly across desktop/mobile split panes, nested same-origin iframes, open Shadow roots, and with DevTools open or detached.
7. **Full Test Suite & Typecheck Green**: `npm run typecheck`, all unit tests (`npm test`), and integration test suites pass with 0 errors.

---

Status: DONE
Summary: Produced candidate plan slot 2 for Main-owned semantic ref authority clean cutover. Comprehensive 5-phase sequential plan with exact files, interfaces, fail-closed target/generation validation, zero DOM mutations, cross-plan alignment, risk mitigations, rollback protocols, and observable acceptance criteria.
Concerns/Blockers: None. All requirements derived directly from the immutable ultra evidence packet and cited repository contracts.
