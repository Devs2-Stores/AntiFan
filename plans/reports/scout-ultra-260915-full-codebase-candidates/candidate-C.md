<!-- Ultra Verifier source material. Anonymized candidate C. -->
<!-- Controller-private mapping: C = Candidate5. Self-ratings stripped before judging. -->
<!-- NOTE: 7 paths in these raw reports failed controller validation and were dropped/corrected -->
<!-- in the materialized union (plans/reports/scout-union-260915-full-codebase-ultra.md §0.2). -->

{
  "report": "# AntiFan Browser Desktop (v1.3.6) — Ultra Verifier Codebase Scout Report\n\n## 1. Executive Architecture Summary\n\nAntiFan Browser Desktop is a specialized local Chromium companion, execution control plane, and verification engine designed for autonomous coding agents (Oh My Pi, Claude Code, Cursor, Antigravity) developing and auditing high-performance e-commerce storefronts (Haravan, Sapo, Shopify).\n\n### Core Architectural Pillars\n- **Dual-Plane Runtime Isolation**: The Electron main process completely decouples human interactive browsing from autonomous agent execution. The user interacts through a custom Electron `BrowserWindow` with native `WebContentsView` panes (toolbar, primary webview, mobile/desktop split view, and docked/popout xterm.js terminals). When an AI agent launches (`scripts/antifan-agent.cjs`), it authenticates with the local `BridgeServer` (WebSocket on `127.0.0.1:20129` prod / `20130` dev) and provisions an isolated, offscreen agent tab with dedicated session storage. The agent cannot ambiently latch onto or hijack the user's active foreground tab.\n- **Generation & Mutation Fencing**: Stale target execution is prevented through monotonic epoch counters: `browserEpoch`, `documentGeneration` (bumped on navigation/reload), and `mutationRevision` (bumped on DOM writes). Effectful capabilities (write, eval, click, type) throw `TARGET_STALE` when evaluated against an older generation.\n- **Strict Single Terminal Authority**: Terminal sessions are managed by a singular composition-root `TerminalManager` backed by `node-pty`. Process output is captured into a 2 MiB / 4096-chunk in-memory delivery journal (`SessionDeliveryJournal`), replayed to the UI via `getDelta` sequence recovery in `standalone.js`, with write queue throttling via `terminal-write-dispatcher.js`.\n- **Physical Device Execution Surface**: Beyond Chromium emulation, AntiFan integrates directly with physical iOS devices over `usbmuxd` TCP multiplexing and WebDriverAgent (WDA) REST endpoints (`http://127.0.0.1:8100`), tracking distinct `deviceEpoch` (USB re-plug) and `sessionGeneration` (WDA restart) lifetimes without requiring Appium.\n- **Deterministic Verification Substrate**: All verification claims are evaluated by `VerificationEvaluator` against live DOM, CSS, and visual metrics. B-Lite v2 loop invariants enforce that verification engines never directly mutate or rollback the workspace—only Main's path-scoped file restore may write to disk.\n- **Super Core Evidence Store**: Persistent knowledge, past cases, anti-patterns, and platform semantic rules are stored in a local SQLite database (`packages/super-core`, schema v5) in WAL mode, governed by Zero Silent Skip and strict evidence anchor invariants.\n\n---\n\n## 2. Subsystems & Key Files\n\n### 2.1 Electron Main Subsystems (`src/main/`)\n- `src/main/index.ts`: Application bootstrap composition root, command-line switch configuration, single-instance lock enforcement, custom privileged protocol registration (`antifan-preview`), lifecycle logging, and graceful shutdown orchestration.\n- `src/main/control-plane/control-plane-runtime.ts`: Central runtime coordinator binding projects, workspaces, chat stores, invocation ledgers, receipt stores, artifact stores, capability catalogues, and terminal managers.\n- `src/main/browser/native-tab-host.ts`: 7600-line central tab controller managing `BrowserWindow`, toolbar and split `WebContentsView`s, tab navigation queues (`targetOperationQueues`), generation counters, and view geometry.\n- `src/main/browser/tab-automation-host.ts`: Isolated-world automation engine executing actions in Chrome World 1004 (`ISOLATED_AGENT_WORLD_ID`), computing Bézier cursor trajectories, and enforcing `BLOCKING_PREFLIGHT_CODES` (`TARGET_OBSCURED`).\n- `src/main/browser/tab-devtools-host.ts`: Developer utility host providing GPU lens, screen ruler, font finder, staircase prewarm walks (`buildStaircasePrewarmScript`), and visual capture envelopes.\n- `src/main/browser/terminal-manager.ts`: Canonical single-instance terminal host wrapping `node-pty`, managing persistent terminal sessions in `terminal-sessions.json`, and maintaining the 2 MiB rolling `SessionDeliveryJournal`.\n- `src/main/browser/split-review-coordinator.ts`: Dual-surface layout coordinator computing desktop (1440px) and mobile (390px) responsive panes with synchronous navigation mirroring.\n- `src/main/browser/semantic-ref-registry.ts`: Monotonic reference registry mapping DOM elements to stable `@e1..@eN` handles for agent interactions.\n- `src/main/browser/tracker-isolation.ts`: Ephemeral third-party vendor script blocker injecting stub scripts to neutralize analytics/tag-manager noise during theme QA audits.\n- `src/main/browser/profile-ownership.ts`: Exclusive lockfile manager for the persistent Chromium profile directory, preventing multi-process corruption and detecting previous unclean shutdowns.\n- `src/main/bridge/bridge-server.ts`: Authenticated local WebSocket RPC server (`127.0.0.1:20129`/`20130`), issuing pairing tokens, extension grants, and routing capability requests to the control plane.\n- `src/main/tools/capability-catalogue.ts`: Central capability repository enforcing effect policies (read/write/execute/eval), lease validity, argument schemas, and generation fences.\n- `src/main/tools/browser-control-port.ts`: Decoupled interface exposing tab operations, viewport gates, and screenshot routines to the capability catalogue.\n- `src/main/tools/browser-capabilities.ts`: Capability definitions for `anti.browser.*`, `anti.inspect.*`, `anti.agent.*`, `anti.screenshot.*`, and `theme.*`.\n- `src/main/tools/device-capabilities.ts`: Capability definitions for physical iOS hardware: `device.list`, `device.status`, `device.tap`, `device.swipe`, `device.type`, `device.screenshot`, `device.open_safari`.\n- `src/main/tools/core-capabilities.ts`: Capability definitions bridging MCP tool invocations to the Super Core SQLite store (`core.query`, `core.context_pack`, `core.recommend`).\n- `src/main/tools/artifact-store.ts`: Content-addressed artifact persistence with run-scoped leasing, byte-budget preflights, and index hashing.\n- `src/main/tools/artifact-retention-cleaner.ts`: Automated sweeper pruning captures and run directories exceeding age or byte ceilings while preserving permanent reports.\n- `src/main/verification/verification-evaluator.ts`: Ground-truth evaluator assessing evidence bundles against proof obligations and document generation barriers.\n- `src/main/verification/verification-contract.ts`: Type contracts defining claims, proof obligations, evidence samples, and B-Lite v2 fix-loop boundary rules.\n- `src/main/verification/visual-capture.ts`: CDP-based viewport and full-page capture engine with raster dimension validation and format checking.\n- `src/main/verification/stability-policy.ts`: Frame quiescence and mutation settling policies preventing premature captures during animations.\n- `src/main/qa/theme-qa-workflow.ts`: Multi-scanner theme audit runner evaluating layout, overflow, Liquid syntax, asset integrity, and 26 Haravan/Sapo compliance gates.\n- `src/main/qa/theme-mutation-session.ts`: Transactional workspace backup and restore manager for theme repair operations.\n- `src/main/qa/rules/hs-gate-rules.ts`: Implementation of 26 Haravan/Sapo store readiness rules (HS1 through HS26).\n- `src/main/device/device-manager.ts`: Enumeration and state registry for physical iOS devices, tracking `deviceEpoch` against USB hardware changes.\n- `src/main/device/ios-device-adapter.ts`: WebDriverAgent HTTP REST client implementing Safari automation on connected iPhones without external Appium dependencies.\n- `src/main/device/usbmux-client.ts`: Binary protocol client interfacing with the Apple usbmuxd daemon over Unix domain socket or Windows named pipe.\n- `src/main/session/invocation-ledger.ts`: Partitioned append-only invocation ledger writing sha256-checksummed frames to guarantee idempotent execution.\n- `src/main/session/issue-register.ts`: Durable error ledger tracking detected failure signatures, workarounds applied, and stalemate states.\n- `src/main/workflow/workflow-engine.ts`: Multi-step workflow orchestrator executing sequential capability steps with retry and cancellation support.\n- `src/main/security/windows-acl.ts`: Windows NTFS DACL security utility enforcing SYSTEM + User-only permissions with disabled ACL inheritance.\n- `src/main/server/preview-protocol-handler.ts`: Handler for `antifan-preview://` URLs securely streaming files from capsule workspace directories with directory-traversal defense.\n\n### 2.2 Presentation & UI Layer (`src/renderer/`, `src/preload/`)\n- `src/renderer/toolbar.ts`: Top navigation toolbar handling omnibox suggestions, DevTools toggles, split view presets, Theme QA triggers, and phone status modals.\n- `src/renderer/standalone.js`: Embedded terminal UI managing xterm.js instances, multiline paste interception modals, sequence gap detection, and resync degraded banners.\n- `src/renderer/terminal-write-dispatcher.js`: Microtask-scheduled write queue preventing xterm.js buffer overflow and main thread UI freezing during high-throughput logs.\n- `src/preload/toolbar-preload.ts`: ContextBridge script exposing safe IPC invoke methods from `toolbarApi` to the toolbar renderer.\n- `src/preload/tab-preload.ts`: Injected browser tab script providing Haravan JSON tree viewer, Unicode decoding, and neutralizing `navigator.webdriver`.\n- `src/preload/standalone-preload.ts`: ContextBridge script exposing terminal PTY communication and clipboard operations to `standalone.js`.\n\n### 2.3 Shared Contracts & Protocols (`src/shared/`)\n- `src/shared/control-plane-contracts.ts`: Universal protocol types: `BrowserTarget`, `RuntimeLease`, `FixRequestV2`, `FixResultV2`, `CapabilityError`, and B-Lite v2 lifecycle states.\n- `src/shared/contracts.ts`: Shared UI and IPC interfaces: `AntiFanTab`, `SplitPaneId`, `AntiFanPickedElement`, `TOOLBAR_CHANNELS`, and `TerminalAckPayload`.\n- `src/shared/device-control-contracts.ts`: Data types for physical iOS device control: `DeviceInfo`, `DeviceBinding`, `DevicePoint`, `DeviceSwipe`, and `DEVICE_ERROR_REMEDIATION`.\n\n### 2.4 Monorepo Packages (`packages/`)\n- `packages/super-core/src/schema.ts`: SQLite DDL definitions for schema v5: `artifacts`, `units`, `claims`, `evidence`, `conflicts`, `experience_nodes`, `anti_patterns`, and `workarounds`.\n- `packages/super-core/src/index.ts`: Local-first knowledge engine implementing claim querying, context pack synthesis, outcome ingestion, and candidate adjudication.\n- `packages/site-clone/src/models/clone-ir.ts`: Intermediate representation data model abstracting DOM structures, assets, and styles for theme generation.\n- `packages/site-clone/src/generators/theme-compiler.ts`: Theme compilation engine translating Clone IR into production-ready Haravan Liquid themes.\n- `packages/site-clone/src/generators/independent-html-clone-generator.ts`: Generator producing 100% offline standalone HTML clones with local base64/blob asset localization.\n- `packages/plugin-sdk/manifest-types.ts`: Declarative plugin manifest schema and isolated hook contracts for third-party extensions.\n\n### 2.5 MCP & Agent Entrypoints (`scripts/`)\n- `scripts/antifan-omp-mcp.cjs`: Standalone Node.js MCP stdio proxy exposing 100+ capabilities to AI agents with a structural 240s client timeout ceiling.\n- `scripts/antifan-agent.cjs`: CLI runner discovering running AntiFan desktop instances, acquiring ephemeral session attachments, and spawning agent CLIs.\n- `scripts/antifan-core.cjs`: CLI utility exposing Super Core queries, context packs, and graph operations.\n- `scripts/run-test-pipeline.mjs`: Central pipeline orchestrator executing static audits, compilation, canary suites, fast unit tests, site-clone tests, and e2e runs.\n- `scripts/check-bottlenecks.mjs`: Machine-checked bottleneck ledger validator ensuring every defect entry in `plans/bottlenecks.json` has a verified truth value.\n- `scripts/check-mcp-budget-dominance.mjs`: Compile-time assertion verifying the MCP proxy timeout dominates all server-side capability policies.\n\n### 2.6 Themes & Verification Specs (`themes/`, `specs/`)\n- `specs/base-theme-contract.json`: Machine-readable specification of Haravan flat-directory-v1 Liquid dialect, unsupported filters, and canonical `?themeid=` preview parameters.\n- `specs/qa-matrix.json`: Definition of the 8 QA dimensions (visualFidelity, domSemantics, cssModularity, interactiveOperability, haravanCompliance, assetIntegrity, responsiveParity, performanceCWV) and viewport diff thresholds (<10%).\n- `themes/universal-haravan-base/`: Reference implementation of Haravan flat-directory-v1 theme architecture (`layout/`, `templates/`, `snippets/`, `config/`, `assets/`).\n- `themes/roahtrip-haravan/`: OS 2.0 sections-based theme implementation for modern storefront environments.\n\n---\n\n## 3. Cross-Boundary Data Flows & Contracts\n\n### 3.1 Agent Invocation & Dual-Plane Isolation Flow\n```\n[Agent CLI (OMP / Claude / Codex)]\n          │ (stdio JSON-RPC)\n          ▼\n[scripts/antifan-omp-mcp.cjs] (Timeout Ceiling: 240,000ms)\n          │ (WebSocket JSON-RPC via ws://127.0.0.1:20129)\n          ▼\n[BridgeServer (src/main/bridge/bridge-server.ts)]\n          │ (validate attachmentToken & session lease)\n          ▼\n[CapabilityTransportAdapter] ──> [CapabilityCatalogue (src/main/tools/capability-catalogue.ts)]\n                                           │\n                        ┌──────────────────┴──────────────────┐\n                        ▼                                     ▼\n             [BrowserControlPort]                    [DeviceControlPort]\n                        │                                     │\n                        ▼                                     ▼\n         [NativeTabHost / AutomationHost]            [IosDeviceAdapter / usbmuxd]\n          (Offscreen Agent Tab in World 1004)         (Physical iPhone Safari over WDA)\n```\n\n1. `antifan-agent.cjs` connects to `BridgeServer` and calls `antifan.cli.startSession`.\n2. `BridgeServer` delegates to `NativeTabHost.createTab(url, false, { offscreen: true })`, minting a dedicated agent tab.\n3. An `AttachmentRecord` is stored in `AttachmentRegistry` binding the agent process to that specific `tabId`.\n4. MCP tool calls include the `attachmentId` and `browserTarget` (`tabId`, `browserEpoch`, `documentGeneration`).\n5. `CapabilityCatalogue` checks whether `documentGeneration` matches the live tab state. If the tab navigated or reloaded unexpectedly, effectful operations fail closed with `TARGET_STALE`.\n6. When the agent process exits, `AttachmentRegistry` disposes the attachment, triggering `tabHost.closeTab(agentTabId)` without affecting the user's visible tabs.\n\n### 3.2 Verification & Evaluator Contract\n```\n[Tool: anti.verification.record_claim]\n          │ (Claim: scope, targetGeneration, proofObligations)\n          ▼\n[IssueRegister (issue-register.jsonl)] (Status: UNVERIFIED)\n          │\n          │ (Agent performs mutations, then captures evidence)\n          ▼\n[Tool: anti.verification.verify_claim]\n          │ (Collects fresh EvidenceSampleBundle from live tab)\n          ▼\n[VerificationEvaluator (src/main/verification/verification-evaluator.ts)]\n          │\n     ┌────┴──────────────────────────────────────┐\n     │ 1. Freshness Check:                       │\n     │    bundle.documentGeneration >= claimGen  │\n     │    bundle.mutationRevision >= claimMutRev │\n     │    (If stale -> INCONCLUSIVE / RESAMPLE)  │\n     │                                           │\n     │ 2. Completeness & Metric Matching:        │\n     │    Evaluate all critical ProofObligations │\n     │    (Layout, DOM, Visual diff, CSS, etc.)  │\n     └────┬──────────────────────────────────────┘\n          │\n          ▼\n[Outcome Adjudication: VERIFIED | PARTIAL | REJECTED | INCONCLUSIVE]\n          │\n          ▼\n[ReceiptStore (receipts.jsonl)] (Authoritative Decision Receipt)\n```\n\n### 3.3 Theme QA Workflow & Differential Attribution Flow\n1. `theme.qa_validate` initiates `ThemeQaWorkflow.run()`.\n2. An ephemeral tracker-isolation blocklist is applied to the tab via `beginTrackerIsolation()` to suppress Google Analytics, Facebook Pixel, and TikTok tags.\n3. The page undergoes a staircase prewarm walk (`buildStaircasePrewarmScript`) to resolve lazy images.\n4. Five parallel scanners run against the live DOM and network logs:\n   - `PlatformDetector`: identifies platform markers (`Haravan`, `Shopify`, `Sapo`).\n   - `LiquidErrorScanner`: checks for raw `{{` or dotLiquid exceptions.\n   - `ServerCrashScanner`: asserts no HTTP 500 error envelopes exist.\n   - `BrokenAssetScanner`: scans for 404 image/script/CSS resources.\n   - `LayoutOverflowEngine`: computes bounding boxes across 1440px, 1024px, 768px, 480px, 390px to flag horizontal overflow.\n5. HS rules (`HsGateRules`) check for platform compliance.\n6. The results are differentially attributed against pre-existing issues in `ThemeTransactionRegistry`, identifying resolved defects versus newly introduced regressions.\n7. `endTrackerIsolation()` safely unblocks the tab.\n\n---\n\n## 4. Unresolved Technical Questions & Architectural Risks\n\nBased on inspection of `plans/bottlenecks.json`, unit/canary tests, and main process implementations, the following open architectural risks and bottlenecks require careful attention:\n\n### 4.1 Open Bottleneck B19: Canary Settle Starvation by Long-Running Carousels\n- **Location**: `src/main/verification/capture-settle.ts` & `.canary/tools/canary-settle.mjs`\n- **Mechanism**: The DOM quiescence predicate sums `addedNodes + removedNodes` and requires a silent window of $\\ge 1500\\text{ ms}$ inside a $9000\\text{ ms}$ budget.\n- **Risk**: Storefronts with continuous CSS/JS carousels (e.g., auto-advancing hero banners ticking every 1000ms) perpetually reset the mutation counter, causing the settle gate to exhaust its budget and report `SETTLE_TIMEOUT` or produce unstable visual capture baselines.\n\n### 4.2 Open Bottleneck B20: Full-Page CDP Capture 16,384px Dimension Limit\n- **Location**: `src/main/verification/visual-capture.ts:24` (`CAPTURE_MAX_DIMENSION = 16384`)\n- **Mechanism**: Chromium's underlying Skia/CDP rasterizer caps single-buffer `Page.captureScreenshot` allocations at 16,384 CSS pixels.\n- **Risk**: Storefront category/home pages exceeding 16,384px height fall back to main-thread tiled composition. If dynamic scroll-triggered sticky headers or parallax elements shift between tile captures, vertical seam tearing occurs in the resulting comparison artifact.\n\n### 4.3 Open Bottleneck B29: Shadowing MCP Routing Rows\n- **Location**: `scripts/antifan-omp-mcp.cjs:CAPABILITY_MAP` & `scripts/check-mcp-budget-dominance.mjs`\n- **Mechanism**: 23 `anti.*` routing rows in the standalone proxy redirect capability names that the server's `CapabilityCatalogue` already natively registers (e.g., `anti.browser.tabs.create`, `navigate`, `reload`, `anti.inspect.dom`).\n- **Risk**: When a proxy row redirects a name, the proxy's translation takes precedence over the server's implementation. If the server registers an alias with different parameter defaults (as occurred with `anti.browser.tabs.list` window-wide vs session-scoped in B28), removing or maintaining these rows can cause silent behavioral divergence between direct WebSocket and stdio MCP clients.\n\n### 4.4 Open Bottleneck B30: Visual Compare Normalization Exceeding 15s Bound\n- **Location**: `src/main/tools/browser-capabilities.ts` & `.canary/15-pages/_verdicts.json`\n- **Mechanism**: During `anti.visual.compare`, reversible DOM normalization (freezing media, stripping scrollbars, neutralizing dynamic timestamps) is bounded to 15,000ms.\n- **Risk**: Heavy storefronts with large DOM trees (e.g., 5000+ elements) exceed the 15s normalization threshold. As recorded in attempt `attempt-96a175b8`, this causes `capture.valid = false`, resulting in `CAPTURE_INVALID` and an unadjudicated `INCONCLUSIVE` campaign verdict.\n\n### 4.5 Open Bottleneck B32: Campaign Verdict Revision-Binding Drift\n- **Location**: `scripts/lib/campaign-verdicts.mjs:241,272` & `.canary/15-pages/_verdicts.json`\n- **Mechanism**: Aggregated verdict artifacts have recorded `exit`, `finishedAt`, and `instance` as null, with 24 of 45 cases carrying `routeIdentity: null` while still being adjudicated PASS or FAIL.\n- **Risk**: Without strict revision binding and verified route identity on every adjudicated case, benchmark and fidelity numbers cannot be authoritatively attributed to the commit at HEAD, risking regression masking across release cuts.\n\n---\n\n## 5. Verification Proof & Quality Gates\n\nThe codebase enforces a multi-tier automated test pipeline (`scripts/run-test-pipeline.mjs`):\n1. `audit`: Validates `plans/bottlenecks.json` via `scripts/check-bottlenecks.mjs` (enforcing that closed rows remain absent and open rows are documented).\n2. `plans:check`: Validates plan status syntax across `plans/**/plan.md`.\n3. `compile`: Builds native shim, asserts emit integrity (`check-emit-integrity.mjs`), compiles TypeScript with incremental caching (`.compiled/.tsbuildinfo`), enforces MCP budget dominance (`check-mcp-budget-dominance.mjs`), prunes orphan emit, copies static renderer assets, and builds extension manifests.\n4. `test:canary`: Executes the 12 canary suites covering settle contracts, readiness floors, route identities, and evidence provenance.\n5. `test:fast` & `test:site-clone`: Runs unit tests across all compiled modules and packages.\n6. `test:integration`, `test:main`, `test:e2e`: Runs full Electron main-process integration tests and IPC pipeline verification.",
  "architecture": "AntiFan Browser Desktop (v1.3.6) employs a Dual-Plane architecture separating human interaction from autonomous agent automation:\n\n1. Control Plane & Automation Plane:\n   - Standalone MCP Stdio Proxy (`scripts/antifan-omp-mcp.cjs`) connects over local WebSocket RPC to the Electron `BridgeServer` (port 20129 prod / 20130 dev on 127.0.0.1).\n   - The CLI runner (`scripts/antifan-agent.cjs`) acquires an ephemeral session attachment (`antifan.cli.startSession`), isolates the target authority to a dedicated offscreen agent tab (preventing ambient hijack of the user's foreground tab), injects credentials, and guarantees clean teardown via `AttachmentRegistry`.\n   - Invocations are dispatched via `CapabilityTransportAdapter` into `CapabilityCatalogue`. Effectful operations are strictly fenced against `documentGeneration` and `mutationRevision` barriers; any drift triggers fail-closed `TARGET_STALE`.\n   - The Physical iOS Device automation surface operates as a first-class peer adapter (`IosDeviceAdapter`) talking directly to WebDriverAgent (WDA) over `usbmuxd` TCP multiplexing, tracking separate `deviceEpoch` (physical plug events) and `sessionGeneration` (WDA process lifecycles).\n\n2. Presentation & Native Host Layer:\n   - `NativeTabHost` manages the primary `BrowserWindow`, `WebContentsView` instances for toolbar, backdrop, and browser tabs (including dual-pane split review for desktop/mobile).\n   - Operations on tabs are strictly serialized per tab via `targetOperationQueues` and bounded by `TARGET_OPERATION_ACQUIRE_BOUND_MS` (15s) with explicit ownership attribution (`targetOperationOwners`).\n   - Terminal management is owned by a singular canonical `TerminalManager` (enforcing a strict single-instance invariant) backed by `node-pty`, a bounded 2 MiB / 4096-chunk delivery journal (`SessionDeliveryJournal`), and UI-side delta replay and sequence gap recovery in `standalone.js`.\n\n3. Verification, QA & Evidence Substrate:\n   - Verification is governed by deterministic evidence gates in `VerificationEvaluator`. High confidence or model priors cannot override missing or failed mechanical evidence.\n   - Theme QA is coordinated through `ThemeQaWorkflow`, integrating 5 specialized scanners (`PlatformDetector`, `LiquidErrorScanner`, `ServerCrashScanner`, `BrokenAssetScanner`, `LayoutOverflowEngine`) and 26 Haravan/Sapo compliance rules (`HsGateRules`), backed by an ephemeral tracker-isolation sandbox (`TrackerIsolation`).\n   - Local evidence, cases, and rules are persisted in SQLite WAL mode via `packages/super-core` (schema v5), adhering to Zero Silent Skip, no auto-promotion, and strict evidence anchors. All file/data storage is protected by Windows NTFS DACL enforcement (`windows-acl.ts`).",
  "summary": "Completed deep Ultra Verifier codebase scout for AntiFan Browser Desktop (v1.3.6). Mapped the entire architecture across Electron Main subsystems (tabhost, bridge, terminal manager, verification evaluator, theme QA, iOS WDA), presentation layers, shared contracts, packages (super-core, site-clone, plugin-sdk), entrypoints, themes, and test suites, citing exact paths and analyzing critical bottlenecks.",
  "files": [
    {
      "description": "Main Electron bootstrap, custom scheme registration, lifecycle journal, profile ownership, and composition root wiring.",
      "path": "src/main/index.ts"
    },
    {
      "path": "src/main/control-plane/control-plane-runtime.ts",
      "description": "Unified runtime coordinator binding project/workspace registries, capabilities, transport, receipts, and terminal manager."
    },
    {
      "path": "src/main/browser/native-tab-host.ts",
      "description": "Core multi-tab layout, WebContentsView lifecycle, split review coordinator, generation counters, and operation serialization queues."
    },
    {
      "description": "Agent visual cursor, Bézier trajectories, isolated world script execution (World 1004), and semantic snapshotting.",
      "path": "src/main/browser/tab-automation-host.ts"
    },
    {
      "description": "Developer tools controller: element picker, GPU lens, font finder, staircase prewarm walks, and visual capture transactions.",
      "path": "src/main/browser/tab-devtools-host.ts"
    },
    {
      "path": "src/main/browser/terminal-manager.ts",
      "description": "Singular composition-root terminal owner, node-pty process manager, 2 MiB rolling delivery journal, and state persistence."
    },
    {
      "description": "Dual-surface split review calculator, desktop/mobile preset synchronization, and layout geometry calculator.",
      "path": "src/main/browser/split-review-coordinator.ts"
    },
    {
      "path": "src/main/browser/semantic-ref-registry.ts",
      "description": "Monotonic element reference registry (@e1..@eN), global rect coordinate mapping, and stale-ref invalidation."
    },
    {
      "description": "Isolated renderer script builders and action validation for World 1004 execution.",
      "path": "src/main/browser/semantic-ref-executor.ts"
    },
    {
      "description": "Ephemeral third-party vendor tracker blocker for sterile theme QA and performance measurement.",
      "path": "src/main/browser/tracker-isolation.ts"
    },
    {
      "path": "src/main/browser/profile-ownership.ts",
      "description": "Persistent Chromium user-data profile locker, single-instance migration, and crash detection."
    },
    {
      "path": "src/main/bridge/bridge-server.ts",
      "description": "Local authenticated WebSocket RPC bridge, pairing queue, mobile remote companion server, and attachment session coordinator."
    },
    {
      "path": "src/main/tools/capability-catalogue.ts",
      "description": "Central tool registry enforcing effect policies (read/write/eval), argument validation, target fences, and timeout dominance."
    },
    {
      "description": "Abstraction boundary between capabilities catalogue and NativeTabHost/TabAutomationHost methods.",
      "path": "src/main/tools/browser-control-port.ts"
    },
    {
      "description": "Registration of all browser, navigation, inspection, cursor, capture, and DOM capabilities.",
      "path": "src/main/tools/browser-capabilities.ts"
    },
    {
      "description": "Registration of physical iOS device capabilities (list, status, tap, swipe, type, screenshot, open_safari).",
      "path": "src/main/tools/device-capabilities.ts"
    },
    {
      "description": "Registration of Super Core evidence queries, context packs, recommendations, and receipts.",
      "path": "src/main/tools/core-capabilities.ts"
    },
    {
      "description": "Content-addressed artifact storage, evidence run leasing, index persistence, and retention sweeps.",
      "path": "src/main/tools/artifact-store.ts"
    },
    {
      "path": "src/main/tools/artifact-retention-cleaner.ts",
      "description": "Background sweeper pruning old non-permanent captures and expired run trees past disk ceilings."
    },
    {
      "description": "In-memory transport adapter translating RPC payloads to typed capability invocations.",
      "path": "src/main/tools/capability-transport.ts"
    },
    {
      "description": "Ground-truth verification engine evaluating claims against document generation barriers and proof obligations.",
      "path": "src/main/verification/verification-evaluator.ts"
    },
    {
      "description": "Contracts for verification claims, proof obligations, evidence bundles, and B-Lite v2 fix-loop boundaries.",
      "path": "src/main/verification/verification-contract.ts"
    },
    {
      "path": "src/main/verification/visual-capture.ts",
      "description": "CDP viewport and full-page capture engine, render surface probing, and JPEG/PNG validation."
    },
    {
      "path": "src/main/verification/visual-region.ts",
      "description": "Spatial coordinate mapping and visible DOM intersection checking across element regions."
    },
    {
      "description": "Interactive action tracing recording pre/post DOM mutations, style deltas, and layout shifts.",
      "path": "src/main/verification/interaction-delta.ts"
    },
    {
      "path": "src/main/verification/stability-policy.ts",
      "description": "Animation settling, RAF stability detection, and frame quiescence policies."
    },
    {
      "description": "Canonical baseline image and DOM storage authority for visual differential comparisons.",
      "path": "src/main/verification/baseline-authority.ts"
    },
    {
      "path": "src/main/verification/scroll-prewarm.ts",
      "description": "Staircase scrolling prewarm script materializing lazy-loaded images and dynamic content."
    },
    {
      "description": "Master theme QA workflow running 5 automated scanners, HS compliance gates, and differential regression attribution.",
      "path": "src/main/qa/theme-qa-workflow.ts"
    },
    {
      "path": "src/main/qa/theme-mutation-session.ts",
      "description": "Transactional workspace snapshotting and rollback manager for safe theme mutation sessions."
    },
    {
      "path": "src/main/qa/theme-transaction-registry.ts",
      "description": "Registry tracking theme mutation transactions and pre-existing vs introduced regressions."
    },
    {
      "path": "src/main/qa/haravan-sync-barrier.ts",
      "description": "Terminal output synchronization cursor and settle barrier for live Haravan theme development sync."
    },
    {
      "description": "Heuristic platform classifier identifying Haravan, Sapo, Shopify, or generic web storefronts.",
      "path": "src/main/qa/scanners/platform-detector.ts"
    },
    {
      "path": "src/main/qa/scanners/liquid-error-scanner.ts",
      "description": "AST and regex scanner detecting raw Liquid syntax output and DotLiquid .NET runtime errors."
    },
    {
      "path": "src/main/qa/scanners/server-crash-scanner.ts",
      "description": "HTTP 500 and backend platform exception page scanner."
    },
    {
      "path": "src/main/qa/scanners/broken-asset-scanner.ts",
      "description": "Detector for 404 assets, missing images, and dead stylesheet/script links."
    },
    {
      "path": "src/main/qa/scanners/layout-overflow-engine.ts",
      "description": "Bounding-box collision detector identifying horizontal overflow and layout clipping across viewports."
    },
    {
      "description": "Rule engine executing 26 Sapo/Haravan compliance checks (HS1–HS26 gates).",
      "path": "src/main/qa/rules/hs-gate-rules.ts"
    },
    {
      "path": "src/main/device/device-manager.ts",
      "description": "Physical iOS device discovery and registry tracking deviceEpoch and WDA sessionGeneration."
    },
    {
      "description": "Port interface contract for iOS device registry and control operations.",
      "path": "src/main/device/device-control-port.ts"
    },
    {
      "path": "src/main/device/ios-device-adapter.ts",
      "description": "WebDriverAgent REST client adapter driving Safari on physical iPhones over usbmuxd."
    },
    {
      "path": "src/main/device/ios-session-manager.ts",
      "description": "WDA session lifecycle manager tracking session generations and crash recovery."
    },
    {
      "description": "Low-level client communicating with Apple usbmuxd service over USB multiplexer.",
      "path": "src/main/device/usbmux-client.ts"
    },
    {
      "description": "TCP port forwarder tunneling host ports to iOS device ports via usbmuxd.",
      "path": "src/main/device/usbmux-forwarder.ts"
    },
    {
      "description": "REST transport client communicating with WebDriverAgent endpoints (status, session, url, screenshot).",
      "path": "src/main/device/wda-rest-client.ts"
    },
    {
      "description": "Partitioned append-only invocation ledger with sha256 checksums and idempotent claim tracking.",
      "path": "src/main/session/invocation-ledger.ts"
    },
    {
      "path": "src/main/session/receipt-store.ts",
      "description": "Durable storage for decision receipts and verification outcomes."
    },
    {
      "description": "Issue and verification register logging live errors, failure signatures, and stalemate states.",
      "path": "src/main/session/issue-register.ts"
    },
    {
      "path": "src/main/session/event-store.ts",
      "description": "Append-only event store capturing runtime telemetry and control-plane transitions."
    },
    {
      "description": "Multi-step execution engine for composite browser/verification workflows.",
      "path": "src/main/workflow/workflow-engine.ts"
    },
    {
      "path": "src/main/workflow/workflow-registry.ts",
      "description": "Registry of stored workflow definitions and custom automation pipelines."
    },
    {
      "path": "src/main/workflow/workflow-schema.ts",
      "description": "Zod schema validation for workflow definitions, steps, retries, and inputs."
    },
    {
      "description": "Strict NTFS DACL security enforcement (SYSTEM + current user SID only; inheritance disabled).",
      "path": "src/main/security/windows-acl.ts"
    },
    {
      "description": "URL sanitization, navigation allowlists, and webPreferences sandboxing.",
      "path": "src/main/security/security-policy.ts"
    },
    {
      "description": "Length-prefixed 4-byte uint32 framing decoder and encoder for Chromium Native Messaging streams.",
      "path": "src/main/native-messaging/framing.ts"
    },
    {
      "description": "Named pipe / domain socket IPC server bridging Chrome Native Messaging to AntiFan Bridge.",
      "path": "src/main/native-messaging/local-ipc-server.ts"
    },
    {
      "path": "src/main/native-messaging/manifest-installer.ts",
      "description": "Windows registry manifest installer for Chrome, Edge, and Brave native messaging companion extensions."
    },
    {
      "path": "src/main/server/preview-protocol-handler.ts",
      "description": "Privileged antifan-preview:// custom scheme protocol handler with directory traversal protection."
    },
    {
      "description": "File system watcher pool delivering debounced reload events for workspace files.",
      "path": "src/main/server/preview-watcher-pool.ts"
    },
    {
      "path": "src/renderer/toolbar.ts",
      "description": "Primary top toolbar UI: tabs, omnibox, split-review controls, DevTools toggles, and Theme QA hub."
    },
    {
      "description": "Standalone xterm.js terminal renderer, multiline paste modal, and delta sync state machine.",
      "path": "src/renderer/standalone.js"
    },
    {
      "path": "src/renderer/terminal-write-dispatcher.js",
      "description": "Microtask-scheduled terminal write queue dispatcher preventing renderer thread starvation."
    },
    {
      "path": "src/renderer/frame-backdrop.ts",
      "description": "Window backdrop and shadow rendering for standalone frames."
    },
    {
      "path": "src/preload/toolbar-preload.ts",
      "description": "Context bridge exposing toolbarApi and IPC channels to the toolbar renderer."
    },
    {
      "path": "src/preload/tab-preload.ts",
      "description": "Tab utilities preload providing Haravan JSON tree viewer and anti-detection flags."
    },
    {
      "path": "src/preload/standalone-preload.ts",
      "description": "Context bridge exposing terminal RPC, clipboard, and session synchronization to standalone.js."
    },
    {
      "description": "Backdrop window IPC bridge.",
      "path": "src/preload/frame-backdrop-preload.ts"
    },
    {
      "description": "Core control-plane contracts: BrowserTarget, RuntimeLease, FixRequestV2, FixResultV2, and CapabilityError.",
      "path": "src/shared/control-plane-contracts.ts"
    },
    {
      "path": "src/shared/contracts.ts",
      "description": "Cross-subsystem IPC contracts: AntiFanTab, SplitPaneId, PickedElement, and Antigravity commands."
    },
    {
      "path": "src/shared/device-control-contracts.ts",
      "description": "Physical iOS device control types, DeviceBinding, DeviceTarget, and error remediation codes."
    },
    {
      "path": "packages/super-core/src/schema.ts",
      "description": "SQLite DDL schema (version 5) for units, claims, evidence, cases, and experience graphs."
    },
    {
      "description": "Core local-first knowledge engine implementing query, context packs, and outcome adjudication.",
      "path": "packages/super-core/src/index.ts"
    },
    {
      "path": "packages/site-clone/src/models/clone-ir.ts",
      "description": "Intermediate representation data model for cloned pages, DOM trees, and asset manifests."
    },
    {
      "path": "packages/site-clone/src/generators/theme-compiler.ts",
      "description": "Compiler generating Haravan-compliant Liquid templates, snippets, and config from Clone IR."
    },
    {
      "description": "Standalone single-file offline HTML generator with localized assets and inlined fonts.",
      "path": "packages/site-clone/src/generators/independent-html-clone-generator.ts"
    },
    {
      "description": "Public manifest types and hook definitions for sandboxed plugins.",
      "path": "packages/plugin-sdk/manifest-types.ts"
    },
    {
      "path": "scripts/antifan-omp-mcp.cjs",
      "description": "Standalone Node.js MCP Stdio server exposing 100+ AntiFan capabilities to OMP/Claude."
    },
    {
      "description": "Per-agent CLI launcher provisioning ephemeral session attachments and offscreen agent tabs.",
      "path": "scripts/antifan-agent.cjs"
    },
    {
      "path": "scripts/antifan-core.cjs",
      "description": "CLI frontend for Super Core evidence store queries, packs, and stats."
    },
    {
      "path": "scripts/run-test-pipeline.mjs",
      "description": "Multi-lane test pipeline runner executing static gates, compilation, canary, and e2e suites."
    },
    {
      "description": "Machine-checkable defect closure checker validating plans/bottlenecks.json against current code.",
      "path": "scripts/check-bottlenecks.mjs"
    },
    {
      "description": "Compile-time assertion ensuring MCP proxy timeout ceiling dominates all server capability timeouts.",
      "path": "scripts/check-mcp-budget-dominance.mjs"
    },
    {
      "description": "Authoritative contract for Haravan themes: DotLiquid dialect, flat-directory layout, and ?themeid= preview parameter.",
      "path": "specs/base-theme-contract.json"
    },
    {
      "path": "specs/qa-matrix.json",
      "description": "Eight-dimension QA evaluation rubric and viewport thresholds for theme verification."
    },
    {
      "path": "plans/bottlenecks.json",
      "description": "Persistent ledger tracking closed, open, and refuted architectural bottlenecks."
    }
  ]
}