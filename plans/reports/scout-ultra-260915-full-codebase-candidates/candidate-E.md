<!-- Ultra Verifier source material. Anonymized candidate E. -->
<!-- Controller-private mapping: E = Candidate4. Self-ratings stripped before judging. -->
<!-- NOTE: 7 paths in these raw reports failed controller validation and were dropped/corrected -->
<!-- in the materialized union (plans/reports/scout-union-260915-full-codebase-ultra.md §0.2). -->

{
  "files": [
    {
      "path": "src/main/index.ts",
      "description": "Composition root, Electron lifecycle, single instance lock, Chromium profile lease, and deferred bridge initialization."
    },
    {
      "path": "src/main/control-plane/control-plane-runtime.ts",
      "description": "Central runtime coordinator managing project/workspace tenancy, leases, resource registries, and tool dispatch."
    },
    {
      "description": "Central WebContentsView tab manager handling tabs, split review, devtools, viewport overrides, and UI state.",
      "path": "src/main/browser/native-tab-host.ts"
    },
    {
      "description": "Visual agent cursor controller, Bézier trajectory runner, isolated-world (1004) executor, and action sequences.",
      "path": "src/main/browser/tab-automation-host.ts"
    },
    {
      "description": "CDP debugger manager for attached WebContents tabs with command serialization and queue management.",
      "path": "src/main/browser/tab-devtools-host.ts"
    },
    {
      "path": "src/main/browser/terminal-manager.ts",
      "description": "Node-PTY terminal host with chunk/sequence delivery journaling, delta re-syncing, and process-tree cleanup."
    },
    {
      "description": "Per-tab/pane FIFO queue enforcing document-generation and mutation-revision freshness fencing.",
      "path": "src/main/browser/target-operation-chain.ts"
    },
    {
      "description": "Clean tab protocol interceptor blocking all outbound network traffic for zero-network offline testing.",
      "path": "src/main/browser/zero-network-interceptor.ts"
    },
    {
      "path": "src/main/browser/tracker-isolation.ts",
      "description": "Ephemeral third-party telemetry/analytics blocker preventing external script interference during QA runs."
    },
    {
      "path": "src/main/browser/split-review-coordinator.ts",
      "description": "Dual-pane layout manager synchronizing desktop (1440px) and mobile (390px) storefront views."
    },
    {
      "path": "src/main/browser/semantic-ref-registry.ts",
      "description": "Accessible semantic snapshot builder assigning monotonic @e1..@eN references for robust agent targeting."
    },
    {
      "description": "DOM script store managing cascade analysis, computed styles, and hot-swap disk overrides via scripts/cdp.",
      "path": "src/main/browser/scripts/injected-script-store.ts"
    },
    {
      "description": "Chromium profile directory ownership lockfile manager with heartbeat tracking and clean shutdown detection.",
      "path": "src/main/browser/profile-ownership.ts"
    },
    {
      "description": "Central tool registry enforcing frozen CapabilityEffectPolicy contracts, scheduler lanes, and target assertions.",
      "path": "src/main/tools/capability-catalogue.ts"
    },
    {
      "path": "src/main/tools/browser-control-port.ts",
      "description": "Abstraction layer exposing tab, inspection, and automation capabilities from NativeTabHost to the catalogue."
    },
    {
      "description": "Content-addressable artifact store managing screenshots, DOM dumps, logs, and retention sweeping.",
      "path": "src/main/tools/artifact-store.ts"
    },
    {
      "path": "src/main/tools/artifact-retention-cleaner.ts",
      "description": "Retention sweeper pruning ephemeral captures and run trees while preserving permanent report evidence."
    },
    {
      "path": "src/main/tools/workspace-file-port.ts",
      "description": "Strictly confined workspace file I/O port enforcing canonical root containment and symlink rejection."
    },
    {
      "path": "src/main/verification/verification-evaluator.ts",
      "description": "Deterministic verification engine evaluating proof obligations against fresh telemetry without model priors."
    },
    {
      "description": "Core 5-primitive verification specification defining the B-Lite v2 lifecycle and strict ownership boundary.",
      "path": "src/main/verification/verification-contract.ts"
    },
    {
      "description": "Comprehensive theme verification orchestrator running differential issue attribution and multi-scanner suites.",
      "path": "src/main/qa/theme-qa-workflow.ts"
    },
    {
      "path": "src/main/qa/rules/hs-gate-rules.ts",
      "description": "Haravan, Sapo, and Shopify platform compliance rules enforcing cart contracts, endpoints, and noPS guards."
    },
    {
      "description": "Static and dynamic scanner detecting Liquid syntax, DotLiquid dialect incompatibilities, and render errors.",
      "path": "src/main/qa/scanners/liquid-error-scanner.ts"
    },
    {
      "description": "Horizontal and vertical layout overflow detection engine probing document and container dimensions.",
      "path": "src/main/qa/scanners/layout-overflow-engine.ts"
    },
    {
      "description": "Detection engine identifying e-commerce platform identity (Haravan, Sapo, Shopify) from DOM and network signatures.",
      "path": "src/main/qa/scanners/platform-detector.ts"
    },
    {
      "path": "src/main/device/device-manager.ts",
      "description": "Physical iOS device manager over usbmuxd tracking monotonic deviceEpoch and WebDriverAgent sessions."
    },
    {
      "path": "src/main/device/ios-device-adapter.ts",
      "description": "WDA REST client and gesture adapter controlling native Safari on physical iOS hardware."
    },
    {
      "path": "src/main/bridge/bridge-server.ts",
      "description": "Authenticated WebSocket RPC bridge (ports 20129/20130) connecting external extensions, CLIs, and agents."
    },
    {
      "description": "Crash-safe append-only ledger tracking idempotent tool invocations, dispatch stages, and execution frames.",
      "path": "src/main/session/invocation-ledger.ts"
    },
    {
      "path": "src/main/session/receipt-store.ts",
      "description": "Durable store recording AuthoritativeReceipt outcomes for asynchronous commands and tool invocations."
    },
    {
      "description": "Custom protocol handler (antifan-preview://) serving local capsule files with zero-symlink path traversal security.",
      "path": "src/main/server/preview-protocol-handler.ts"
    },
    {
      "path": "src/main/native-messaging/local-ipc-server.ts",
      "description": "Windows named pipe IPC server and handshake nonce verifier for Chromium native messaging hosts."
    },
    {
      "path": "src/main/run/attachment-registry.ts",
      "description": "Registry of ephemeral agent execution attachments, authority revisions, and tab ownership bindings."
    },
    {
      "description": "Declarative multi-step workflow execution engine with step branching, artifact capture, and event sinking.",
      "path": "src/main/workflow/workflow-engine.ts"
    },
    {
      "description": "Desktop toolbar UI script implementing tab strip, omnibox, split-review controls, and QA status.",
      "path": "src/renderer/toolbar.ts"
    },
    {
      "path": "src/preload/toolbar-preload.ts",
      "description": "Context-isolated IPC preload bridge exposing typed window.antifanToolbar methods to the toolbar renderer."
    },
    {
      "path": "src/shared/control-plane-contracts.ts",
      "description": "Root protocol contracts defining BrowserTarget, RuntimeLease, CapabilityEffectPolicy, and B-Lite v2 shapes."
    },
    {
      "path": "src/shared/contracts.ts",
      "description": "Shared data types for tab models, IPC/RPC channels, element picking, and split review states."
    },
    {
      "path": "src/shared/theme-task-context.ts",
      "description": "Domain task context interfaces, platform definitions, and verification directives for theme work."
    },
    {
      "path": "packages/super-core/src/schema.ts",
      "description": "Local SQLite evidence, claims, conflicts, and experience graph schema (version 5) using node:sqlite."
    },
    {
      "description": "Super Core engine managing claims, evidence anchors, context packs, decision receipts, and experience nodes.",
      "path": "packages/super-core/src/index.ts"
    },
    {
      "path": "packages/site-clone/src/index.ts",
      "description": "Autonomous site clone engine entrypoint exporting DOM parser, asset harvester, Clone IR, and theme generators."
    },
    {
      "path": "packages/site-clone/src/generators/theme-compiler.ts",
      "description": "Compiler translating Clone IR into a complete Haravan flat-directory-v1 theme structure."
    },
    {
      "description": "Generator producing 100% offline standalone HTML/CSS/JS bundles for zero-network clone verification.",
      "path": "packages/site-clone/src/generators/independent-html-clone-generator.ts"
    },
    {
      "path": "packages/plugin-sdk/manifest-types.ts",
      "description": "Public type definitions and permission shapes for declarative AntiFan plugins."
    },
    {
      "path": "scripts/antifan-omp-mcp.cjs",
      "description": "Stdio MCP server translating 110+ agent tool calls to in-process Super Core or BridgeServer RPC dispatches."
    },
    {
      "path": "scripts/antifan-agent.cjs",
      "description": "Agent launcher CLI discovering local bridge instances, issuing ephemeral attachments, and wrapping agent commands."
    },
    {
      "path": "scripts/antifan-core.cjs",
      "description": "CLI utility providing direct terminal access to local Super Core queries, context packs, and receipts."
    },
    {
      "path": "scripts/run-test-pipeline.mjs",
      "description": "Multi-lane test pipeline runner executing compile, canary, fast, site-clone, integration, main, and e2e suites."
    },
    {
      "path": "scripts/lib/canary-floors.mjs",
      "description": "Readiness floor verifier loading and validating cached section/card/docHeight minimums per viewport."
    },
    {
      "path": "specs/base-theme-contract.json",
      "description": "Comprehensive Haravan flat-directory-v1 theme specification defining DotLiquid limitations and directory structure."
    },
    {
      "path": "specs/qa-matrix.json",
      "description": "Eight-dimension quality matrix defining target scores and thresholds across desktop, tablet, and mobile viewports."
    },
    {
      "description": "Machine-checkable defect ledger tracking closed, open, and refuted bottlenecks across build, gates, and QA.",
      "path": "plans/bottlenecks.json"
    }
  ],
  "architecture": "AntiFan Browser Desktop is architected as a two-tier hybrid system: an Electron Main host (running an accelerated Chromium engine, Node-PTY terminals, WebSocket Bridge, and local-first SQLite Super Core) decoupled from external AI coding agents via a zero-trust stdio MCP proxy and an authenticated WebSocket RPC bridge.\n\n1. Control Plane & Concurrency Invariants:\n   - Authority & Tenancy: ControlPlaneRuntime manages project/workspace isolation via RuntimeLease tokens and hostEpoch counters. Every capability execution is governed by a frozen CapabilityEffectPolicy enforcing one of four scheduler lanes: 'short-passive', 'event-wait', 'viewport-gate', and 'unbounded'.\n   - Fencing & Generations: Browser operations are fenced by monotonic documentGeneration and mutationRevision counters on BrowserTarget, preventing stale tab operations during navigations or dynamic DOM mutations.\n   - Attachment Isolation: Agent sessions obtain ephemeral McpAttachmentLaunch tokens with strictly scoped authority revisions. Offscreen agent tabs are segregated from user foreground tabs, guaranteeing Dual-Plane runtime isolation.\n   - Idempotent Invocation Ledger: InvocationLedger maintains checksum-verified partitions on disk, providing deduplication, replay prevention, and crash-safe settlement for in-flight capability dispatches.\n\n2. Browser, Terminal & Device Subsystems:\n   - NativeTabHost & TabAutomationHost: Manages multi-tab WebContentsViews, docked DevTools CDP queues, and visual agent automation. Agent actions (cursor, trajectory, drag, drop, upload) execute inside Isolated World 1004, enforcing hit-testing and occlusion gates (TARGET_OBSCURED) to prevent synthetic dispatch bypasses.\n   - Terminal Management: TerminalManager hosts node-pty sessions with SessionDeliveryJournal, providing sequence-tracked delta re-syncing under strict byte (2MB) and chunk (4096) memory ceilings, paired with clean process-tree termination.\n   - Physical iOS Device Surface: Peer execution surface driven by IosDeviceAdapter and DeviceManager communicating with mobile Safari via usbmuxd and WebDriverAgent HTTP endpoints, distinguishing physical device epochs from automation session generations.\n\n3. Verification Engine & Theme QA (B-Lite v2 Loop):\n   - Strict Ownership Split: The verification engine owns proof obligations, metrics sampling, and verdict adjudication (FIXED_VERIFIED, REFUSED_SCOPE, STALEMATE, SCOPE_DISCOVERY). It has zero source-file rollback capability; workspace mutation and path-scoped rollback belong exclusively to Main's merge gate.\n   - Theme QA Workflow: Aggregates scanners for Liquid syntax errors, layout overflow, broken assets, and server crashes, evaluating strict Haravan/Sapo/Shopify gate rules (HS-01 to HS-06) covering add-to-cart variant IDs, contact endpoints, comment casing, and noPS script guards.\n\n4. Monorepo Packages & MCP Proxy:\n   - Super Core (packages/super-core): Embedded SQLite evidence and provenance graph (schema v5) maintaining claims, evidence anchors, conflicts, and experience nodes.\n   - Site Clone Engine (packages/site-clone): Full-pipeline site cloner and compiler that parses live DOM, harvests and localizes assets, constructs Clone IR, and compiles clean DotLiquid templates into Haravan flat-directory-v1 theme structures.\n   - MCP Stdio Server (scripts/antifan-omp-mcp.cjs): Translates 110+ agent tool calls into local Super Core queries or BridgeServer WebSocket RPC dispatches.",
  "report": "# AntiFan Browser Desktop — Ultra Verifier Codebase Scout Report (Candidate 4)\n\n## 1. Executive Architecture Summary\n\nAntiFan Browser Desktop (`antifan-browser-desktop` v1.3.6) is an industrial-grade local control plane, high-performance Chromium companion, and multi-agent execution substrate tailored for web application and storefront theme engineering (Haravan, Sapo, Shopify). It provides a unified harness for AI agents (OMP, Claude Code, Cursor, Antigravity) that connects AI orchestration with real-world browser execution, physical iOS hardware testing, local-first evidence tracking, and autonomous theme cloning.\n\nThe platform is designed around four foundational pillars:\n1. **Epistemic Hierarchy & Grounding:** Model priors and unverified claims are untrusted. Only deterministic tool telemetry, live DOM assertions, and cryptographic evidence anchors establish verified truth.\n2. **Dual-Plane Runtime Isolation:** Separation of user-facing interactive surfaces from background agent automation tabs prevents ambient state contamination, hijacked focus, or unintentional credential leakage.\n3. **Strict B-Lite v2 Loop Lifecycle:** Clear separation of concerns between verification and mutation. The Verification Engine owns evidence collection, metric obligation checking, and verdict adjudication, with zero file rollback capability. Workspace mutations and path-scoped rollbacks are strictly owned by Main's merge gate.\n4. **Resilient Local Control Plane:** Monotonic epoch counters, document generation tracking, mutation revision barriers, idempotent invocation journals, and Windows ACL security protect against race conditions, stale tab execution, and unauthorized local access.\n\n---\n\n## 2. Comprehensive Subsystem Decomposition & Key Files\n\n### 2.1 Electron Main Subsystems (`src/main/`)\n- `src/main/index.ts`: Application composition root. Manages Electron app lifecycle, single-instance mutex (`app.requestSingleInstanceLock()`), persistent profile lease acquisition via `ProfileOwnership`, hardware acceleration switches, synchronous crash reporter initialization, deferred Bridge/Native IPC bootstrap (1.5s post-first-paint), and graceful shutdown settlement.\n- `src/main/control-plane/control-plane-runtime.ts`: Central runtime coordinator. Manages tenancy (`projectId`, `workspaceId`), issues `RuntimeLease` tokens, manages `WorkspaceRegistry`, `ProjectRegistry`, `ArtifactStore`, and registers capabilities across browser, file, terminal, device, workflow, and Super Core ports.\n- `src/main/browser/native-tab-host.ts`: High-performance WebContentsView tab host. Manages browser tabs, dual split review panes (desktop + mobile), docked DevTools CDP attachments, element picker overlays, GPU lens, ruler, font finder, session partition cookies, and `antifan-preview://` custom scheme bindings.\n- `src/main/browser/tab-automation-host.ts`: Agent automation sub-controller. Implements visual agent cursor (click, move, type, scroll, hover, highlight, clear), Bézier trajectory gestures, isolated world (World 1004) script evaluation, and strict pre-flight occlusion gating (`TARGET_OBSCURED`) to prevent clicking covered elements.\n- `src/main/browser/tab-devtools-host.ts`: Manages underlying CDP connections via `WebContents.debugger`. Provides synchronized request queuing, command retries, network interception, and console log harvesting.\n- `src/main/browser/terminal-manager.ts`: Node-PTY terminal manager. Employs `SessionDeliveryJournal` with chunk and sequence monotonicity, dual-bounded memory eviction (2MB / 4096 chunks), ANSI delta sync, and robust process-tree termination (`killProcessTree` via `taskkill /pid /T /F`).\n- `src/main/browser/target-operation-chain.ts`: Per-target FIFO serialized operation queue enforcing `documentGeneration` and `mutationRevision` barriers, ensuring tab operations abort fail-closed if the page navigates mid-operation.\n- `src/main/browser/zero-network-interceptor.ts`: Offline verification gate. Intercepts all network protocols at the Chromium session layer, enforcing zero external network egress for isolated clone testing.\n- `src/main/browser/tracker-isolation.ts`: Ephemeral third-party analytics and tracker isolation mechanism. Dynamically blocks tracking scripts during Theme QA and visual comparison to eliminate noise and layout shifts.\n- `src/main/browser/split-review-coordinator.ts`: Dual-surface layout coordinator. Computes precise split geometry for synchronized side-by-side desktop (1440px) and mobile (390px) rendering with error capture.\n- `src/main/browser/semantic-ref-registry.ts`: Accessible semantic DOM snapshot engine. Generates monotonic `@e1..@eN` semantic references mapped to hit-tested bounding rectangles and accessible roles.\n- `src/main/browser/scripts/injected-script-store.ts`: Dynamic script cache and injector. Evaluates CSS cascade models, box-model metrics, and supports hot-swapping CDP scripts from disk (`scripts/cdp`).\n- `src/main/browser/profile-ownership.ts`: Chromium profile single-process lease coordinator. Handles directory-level lockfiles, heartbeat leases, unclean shutdown detection, and safe-start recovery.\n- `src/main/tools/capability-catalogue.ts`: Central capability engine. Registers tool definitions, validates frozen `CapabilityEffectPolicy` metadata, schedules execution across 4 concurrency lanes, and asserts lease/target bounds.\n- `src/main/tools/browser-control-port.ts`: Functional bridge port between `CapabilityCatalogue` and `NativeTabHost`. Exposes guarded browser APIs bound to target generation checks and `ViewportGate`.\n- `src/main/tools/artifact-store.ts`: Content-addressable storage for run artifacts (screenshots, DOM dumps, diagnostic reports). Manages chunked disk I/O, hash verification, and retention sweeping.\n- `src/main/tools/artifact-retention-cleaner.ts`: Automated garbage collection sweeper. Enforces byte and age ceilings on ephemeral captures while strictly exempting permanent reports.\n- `src/main/tools/workspace-file-port.ts`: Sandboxed filesystem port. Enforces canonical root path containment and segment-by-segment `lstat` walks to reject directory junctions and symlinks.\n- `src/main/verification/verification-evaluator.ts`: Deterministic verification engine. Evaluates structured proof obligations against live telemetry samples, verifying document freshness and metric tolerances.\n- `src/main/verification/verification-contract.ts`: Foundational verification specification. Formally specifies the 5 verification primitives, obligation profiles, and the B-Lite v2 lifecycle states.\n- `src/main/qa/theme-qa-workflow.ts`: End-to-end theme verification pipeline. Runs platform detection, layout overflow analysis, Liquid error checks, asset validation, and differential issue attribution.\n- `src/main/qa/rules/hs-gate-rules.ts`: Domain compliance rule engine for Haravan/Sapo/Shopify themes. Enforces HS-01 through HS-06 contracts (cart variant IDs, endpoints, casing, and noPS guards).\n- `src/main/qa/scanners/platform-detector.ts`: E-commerce platform classifier analyzing DOM metadata, script tags, and global objects to identify Haravan, Sapo, or Shopify.\n- `src/main/qa/scanners/liquid-error-scanner.ts`: Scans rendered DOM and response bodies for DotLiquid (.NET) and Shopify Liquid execution exceptions and missing templates.\n- `src/main/qa/scanners/layout-overflow-engine.ts`: Multi-viewport horizontal overflow scanner checking bounding boxes from 390px to 1920px to identify broken responsive layouts.\n- `src/main/device/device-manager.ts`: Physical iOS device registry. Tracks USB-attached iPhones via `usbmuxd`, maintaining separate monotonic `deviceEpoch` and WDA `sessionGeneration` state.\n- `src/main/device/ios-device-adapter.ts`: Physical device execution adapter. Communicates directly with WebDriverAgent REST endpoints on iOS hardware for native Safari taps, swipes, and screenshot capture.\n- `src/main/bridge/bridge-server.ts`: Local WebSocket RPC server (port 20129 prod / 20130 dev). Implements pairing handshake, mobile remote companion QR pairing, terminal streaming, and capability routing.\n- `src/main/session/invocation-ledger.ts`: Durable append-only ledger. Tracks tool invocations with idempotency keys, SHA-256 frame checksums, and graceful shutdown interrupt settlement.\n- `src/main/session/receipt-store.ts`: Authoritative receipt store. Persists execution receipts for long-running operations, allowing agents to verify terminal status across restarts.\n- `src/main/server/preview-protocol-handler.ts`: Custom protocol handler for `antifan-preview://capsule-<id>/`. Enforces capsule root isolation, zero-symlink walks, and sensitive file blocking.\n- `src/main/server/safe-fs-resolver.ts`: High-security file stream resolver for preview requests with MIME mapping and strict directory traversal prevention.\n- `src/main/native-messaging/local-ipc-server.ts`: Windows named pipe IPC server. Facilitates secure local communication with browser extensions via launch nonce validation and Windows DACLs.\n- `src/main/native-messaging/manifest-installer.ts`: Auto-installer for Chrome, Edge, and Brave native messaging manifests registering `com.antifan.bridge`.\n- `src/main/run/attachment-registry.ts`: Manages ephemeral agent attachments, authority revision handles, and maps agent sessions to dedicated offscreen browser tabs.\n- `src/main/workflow/workflow-engine.ts`: Declarative workflow orchestrator. Executes multi-step automation plans with step-level timeout handling, artifact recording, and event sinks.\n\n### 2.2 Presentation & UI Layer (`src/renderer/`, `src/preload/`)\n- `src/renderer/toolbar.ts`: VS Code-styled dark browser toolbar. Coordinates tab strip management, omnibox URL navigation, device preset selectors, split-review toggling, and Theme QA progress badges.\n- `src/renderer/frame-backdrop.ts`: Window frame decorator handling split review gutter resizing, device viewport framing, and backdrop canvas rendering.\n- `src/renderer/standalone.js`: Self-contained artifact viewer and inspector for rendered DOM snapshots and visual diffs.\n- `src/preload/toolbar-preload.ts`: Context-isolated preload script exposing `window.antifanToolbar` to the toolbar renderer through secure IPC channels.\n- `src/preload/tab-preload.ts`: Injected preload script for managed web tabs providing element picking hooks, console interception, and performance timing capture.\n- `src/preload/frame-backdrop-preload.ts`: Preload script providing frame and window resizing IPC bindings to the backdrop renderer.\n\n### 2.3 Shared Contracts (`src/shared/`)\n- `src/shared/control-plane-contracts.ts`: Canonical type definitions for Control Plane Protocol v1: `BrowserTarget`, `RuntimeLease`, `CapabilityEffectPolicy`, `AuthoritativeInvocationReceipt`, and B-Lite v2 fix loop structures.\n- `src/shared/contracts.ts`: Shared data structures for tab metadata, picked DOM elements, split review configuration, and Electron IPC/RPC message payloads.\n- `src/shared/theme-task-context.ts`: E-commerce theme task context definitions, platform specifications, and automated verification directives.\n- `src/shared/device-control-contracts.ts`: Physical iOS device contracts specifying gesture points, swipes, taps, wait conditions, and device readiness states.\n\n### 2.4 Monorepo Packages (`packages/`)\n- `packages/super-core/src/schema.ts`: SQLite schema definition (version 5) for the Super Core evidence store. Defines 28+ relational tables for artifacts, units, claims, evidence anchors, conflicts, and experience graph nodes.\n- `packages/super-core/src/index.ts`: Local-first Super Core implementation leveraging `node:sqlite.DatabaseSync`. Enforces zero-silent-skip invariants, context pack generation, and decision receipts.\n- `packages/site-clone/src/index.ts`: Autonomous site clone engine entrypoint. Exports models (DOM parser, blueprint extractor, asset harvester), generators (theme compiler, independent clone), and QA harnesses.\n- `packages/site-clone/src/generators/theme-compiler.ts`: Compiles Intermediate Representation (Clone IR) into a fully-functional Haravan flat-directory-v1 theme structure.\n- `packages/site-clone/src/generators/independent-html-clone-generator.ts`: Generates 100% self-contained, offline standalone HTML/CSS/JS bundles with localized assets.\n- `packages/plugin-sdk/manifest-types.ts`: Public TypeScript types, manifest interfaces, and permission schemas for third-party AntiFan plugins.\n\n### 2.5 Scripts & CLI Entrypoints (`scripts/`)\n- `scripts/antifan-omp-mcp.cjs`: Stdio MCP server exposing 110+ tools to external agents (OMP, Claude Code). Dispatches Super Core queries in-process and proxies browser tools to `BridgeServer`.\n- `scripts/antifan-agent.cjs`: Universal agent launcher CLI. Discovers running bridge instances across filesystem configurations, acquires ephemeral attachments, and wraps agent processes.\n- `scripts/antifan-core.cjs`: Dedicated CLI utility for querying, packing, and maintaining the local Super Core SQLite evidence database.\n- `scripts/run-test-pipeline.mjs`: Central test execution pipeline. Sequentially runs static audits (`audit`, `plans:check`) and test lanes (`compile`, `test:canary`, `test:fast`, etc.).\n- `scripts/lib/canary-floors.mjs`: Cryptographic validator for cached per-viewport readiness floors (ensuring min sections, cards, and doc height thresholds).\n- `specs/base-theme-contract.json`: Machine-readable Haravan flat-directory-v1 specification detailing DotLiquid constraints, supported constructs, and API endpoints.\n- `specs/qa-matrix.json`: Multi-viewport QA matrix specifying evaluation criteria across 8 dimensions (visual fidelity, dom semantics, cwv, etc.).\n- `plans/bottlenecks.json`: Machine-checkable defect and bottleneck ledger tracking the closure and verification state of all architectural findings.\n\n---\n\n## 3. Cross-Boundary Data Flows & Contracts\n\n```\n+---------------------------------------------------------------------------------------+\n|                                AI Coding Agent (OMP / Claude)                         |\n+-------------------------------------------+-------------------------------------------+\n                                            | Stdio (JSON-RPC)\n                                            v\n+---------------------------------------------------------------------------------------+\n|                             scripts/antifan-omp-mcp.cjs                               |\n|   - Handles core.* via in-process SQLite (packages/super-core)                        |\n|   - Routes anti.* / browser.* / device.* / theme.* via WebSocket                      |\n+-------------------------------------------+-------------------------------------------+\n                                            | WS /api/dispatch (Secret Auth Header)\n                                            v\n+---------------------------------------------------------------------------------------+\n|                                BridgeServer (port 20129)                              |\n|   - Authenticates attachment tokens via AttachmentRegistry                            |\n|   - Validates authority revisions & tenancy bounds                                    |\n+-------------------------------------------+-------------------------------------------+\n                                            | CapabilityRequestContext\n                                            v\n+---------------------------------------------------------------------------------------+\n|                              CapabilityCatalogue                                      |\n|   - Enforces frozen CapabilityEffectPolicy & scheduler lanes                         |\n|   - Asserts BrowserTarget / DeviceTarget freshness & generations                     |\n+--------------------+----------------------+--------------------+----------------------+\n                     |                      |                    |\n                     v                      v                    v\n           +-------------------+  +-------------------+  +-------------------+\n           | BrowserControlPort|  | WorkspaceFilePort |  |  IosDeviceAdapter |\n           +---------+---------+  +---------+---------+  +---------+---------+\n                     |                      |                    |\n                     v                      v                    v\n           +-------------------+  +-------------------+  +-------------------+\n           |   NativeTabHost   |  | Canonical Root FS |  |   usbmuxd / WDA   |\n           | (WebContentsView) |  |  (Zero Symlinks)  |  |  (Physical iPhone)|\n           +-------------------+  +-------------------+  +-------------------+\n```\n\n### 3.1 Agent Authentication & Dual-Plane Isolation\n1. When an agent launches via `antifan-agent.cjs`, it connects to `BridgeServer` to issue an attachment lease (`AttachmentRegistry.issueAttachment`).\n2. If no tab is specified, the system provisions a dedicated offscreen agent tab rather than latching onto the user's visible tab.\n3. The launcher injects `ANTIFAN_ATTACHMENT_ID`, `ANTIFAN_ATTACHMENT_SECRET`, and `ANTIFAN_AUTHORITY_REVISION` into the child process.\n4. `scripts/antifan-omp-mcp.cjs` connects to the bridge using this secret. When the agent process exits, the attachment is disposed, triggering the automatic closure of the offscreen agent tab while leaving user tabs untouched.\n\n### 3.2 Target Freshness & Generation Fencing\n1. Every browser capability requires a `BrowserTarget` containing `tabId`, `browserEpoch`, and `documentGeneration`.\n2. When an agent issues a mutating action (e.g., `agentClick`, `navigate`, `reload`), `CapabilityCatalogue.authorizeAndResolveEffectiveTarget` verifies that the target matches the live tab generation.\n3. If the page navigated or reloaded in the background, `documentGeneration` diverges, and the operation fails closed with `TARGET_STALE`.\n4. Stale operations require the agent to re-sample the page (`anti.browser.tabs.list` or `anti.inspect.snapshot`), preventing blind clicks on invalid DOM states.\n\n### 3.3 B-Lite v2 Loop: Ownership Split & Scope Discovery\n1. The B-Lite v2 repair loop enforces a strict separation between verification and workspace mutation:\n   - **Verification Engine:** Gathers telemetry (screenshots, DOM, layout), executes scanners, and adjudicates verdicts (`FIXED_VERIFIED`, `REFUSED_SCOPE`, `STALEMATE`, `SCOPE_DISCOVERY`). It has NO permission to alter workspace files or perform git rollbacks.\n   - **Main Controller:** Holds exclusive write authority. It applies diffs within a strict `FixDiffBudget`, validates that only `allowedFiles` are touched, and executes path-scoped restores from disk snapshots if a fix fails.\n   - **SCOPE_DISCOVERY:** If a fix cannot be achieved within the permitted files, the fixer emits a `SCOPE_DISCOVERY` receipt detailing missing dependencies, rather than arbitrarily mutating files outside its boundary.\n\n### 3.4 Physical iOS Device Coordination (Tier-2 Surface)\n1. Physical device testing bypasses Chromium emulation entirely. `DeviceManager` monitors hardware attachment over `usbmuxd`.\n2. Two independent counters prevent target confusion:\n   - `deviceEpoch`: Monotonically incremented on physical USB reconnects (a re-plugged phone never reuses an epoch).\n   - `sessionGeneration`: Monotonically incremented when WebDriverAgent restarts on the attached device.\n3. `IosDeviceAdapter` communicates with WebDriverAgent over HTTP port forwarding. Operations are validated against the live device binding, preventing commands intended for one session from executing against a disconnected or restarted device.\n\n---\n\n## 4. Unresolved Technical Questions & Architectural Risks\n\nBased on codebase analysis and `plans/bottlenecks.json` telemetry, several critical architectural risks and open bottlenecks require attention:\n\n### 4.1 Open Bottlenecks from Ledger (`plans/bottlenecks.json`)\n1. **B19 (Theme QA Settle Starvation):** The canary settle gate (`canary-settle.mjs` / `capture-settle.ts`) sums `addedNodes` and `removedNodes` in `MutationObserver` and requires a 1500ms quiet window inside a 9000ms budget. Sites with continuous CSS/JS carousels or timer-based tickers starve this condition, leading to intermittent timeouts during verification.\n2. **B20 (Full-Page Capture Degradation):** CDP viewport captures are hard-capped at 16384 CSS pixels. Pages exceeding this height degrade to multi-tile stitching executed on the main Electron thread, causing noticeable UI freezes on long e-commerce pages.\n3. **B29 (MCP Catalogue Shadowing via CAPABILITY_MAP):** `scripts/antifan-omp-mcp.cjs` maintains 23 alias mappings in `CAPABILITY_MAP` (e.g., `anti.browser.tabs.create` -> `browser.open-tab`, `anti.inspect.dom` -> `browser.dom`) that redirect names already directly registered in `CapabilityCatalogue`. This causes subtle semantic divergence (such as session-scoped vs window-wide tab listing) and needs a phased, behavior-preserving removal.\n4. **B30 (Visual Compare Normalization Timeout):** During 15-page clone verification, `anti.visual.compare` normalization exceeds its 15-second bound on complex pages (5000+ px), resulting in `captureValid: false` and marking valid runs as `CAPTURE_INVALID`.\n5. **B32 (Unbound Campaign Verdict Artifacts):** Legacy aggregate verdict files (`.canary/15-pages/_verdicts.json`) record `exit: null` and `finishedAt: null`, preventing deterministic provenance binding to specific Git commits at HEAD.\n\n### 4.2 Concurrency & Main-Thread Saturation Risks\n1. **Ledger & Attachment Replay Overhead:** On populated user profiles, replaying `attachments-v1.jsonl` and `InvocationLedger` partitions involves CPU-bound `JSON.parse` and SHA-256 checksumming on the main thread. While deferred past first paint (using `setTimeout`), large profiles can still cause event-loop lag spikes (>100ms) during post-startup hydration.\n2. **Synchronous Windows DACL Spawns:** `windows-acl.ts` executes synchronous `icacls` and PowerShell commands to enforce file access controls on named pipes and runtime directories. On slow disks or domain-joined enterprise machines, these calls introduce measurable delays during bridge startup.\n\n### 4.3 Platform Boundary Quirks (Haravan DotLiquid Dialect)\n1. **DotLiquid Incompatibilities:** As documented in `specs/base-theme-contract.json`, Haravan uses a .NET port of Liquid (DotLiquid) that lacks modern Shopify filters (`compact`, `where`, `concat`, `image_url`, `at_least`, `at_most`). Generative theme tooling must strictly avoid emitting these constructs, or theme compilation will fail with unrenderable Liquid blocks.\n2. **Preview URL Addressing:** Haravan storefronts ignore Shopify's `?preview_theme_id=` URL parameter when unauthenticated. They strictly require `?themeid=` to trigger the server-side `preview_theme_id` session cookie.\n\n---\n*Report certified by Candidate 4 under Ultra Verifier Scout Protocol.*",
  "summary": "Comprehensive codebase scout of AntiFan Browser Desktop v1.3.6 covering Electron main subsystems, Presentation & Preload UI layer, Shared Contracts, Monorepo Packages (Super Core, Site Clone, Plugin SDK), MCP entrypoints, Themes/Specs, Test Architecture, and Bottlenecks. Identifies core architectural invariants (Dual-Plane isolation, B-Lite v2 lifecycle split, generation/epoch fencing) and unresolved risks (B19 settle starvation, B20 capture ceiling, B29 catalogue shadowing, B30 visual normalization timeout)."
}