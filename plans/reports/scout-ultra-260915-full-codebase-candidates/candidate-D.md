<!-- Ultra Verifier source material. Anonymized candidate D. -->
<!-- Controller-private mapping: D = Candidate2. Self-ratings stripped before judging. -->
<!-- NOTE: 7 paths in these raw reports failed controller validation and were dropped/corrected -->
<!-- in the materialized union (plans/reports/scout-union-260915-full-codebase-ultra.md §0.2). -->

{
  "report": "# AntiFan Browser Desktop (v1.3.6) — Architectural Scout Report\n\n## 1. Executive Architecture Summary\nAntiFan Browser Desktop is an ultra-lightweight, high-performance Chromium companion and local control plane engineered for autonomous AI coding agents (OMP, Claude Code, Cursor, Antigravity). Rather than wrapping a standard headless browser or running isolated Playwright instances, AntiFan unifies:\n1. **Desktop Chromium Host (`src/main/browser/native-tab-host.ts`)**: An Electron 43.4 application managing native `WebContentsView` instances with pinned process partitions (`persist:profile-*`), hardware-accelerated 2D canvas/video decoding, and a dual-surface **Split Review** engine (side-by-side Desktop and Mobile emulation synchronized via loop-guarded navigation coordinators).\n2. **Deterministic Control Plane (`src/main/control-plane/`)**: An authoritative runtime enforcing single-owner runtime leases, exact document generations, monotonic mutation revisions, cryptographic parameter/policy digests, and an append-only invocation ledger.\n3. **Dual-Plane RPC & Transport (`src/main/bridge/`, `scripts/antifan-omp-mcp.cjs`)**: An authenticated WebSocket RPC server (`BridgeServer`, ports 20129/20130) and a standalone Node MCP stdio server that exposes 60+ browser, inspection, agent, artifact, device, and theme tools to external LLM harnesses, while embedding an in-process SQLite Super Core store.\n4. **Tier-2 Physical Reality Gate (`src/main/device/`)**: Direct iOS hardware automation over USB via `usbmuxd` and a dedicated `WebDriverAgent` REST client, providing real mobile Safari execution and screenshot receipts alongside desktop Chromium.\n5. **Theme QA & Verification Engine (`src/main/qa/`, `src/main/verification/`)**: An 8-dimension QA Matrix verifying e-commerce storefronts (Haravan, Shopify, Sapo) against flat-directory contracts and HS1–HS26 gate rules, backed by differential regression tracking, atomic workspace staging, and R0 rollback safety.\n6. **Local Super Core Store (`packages/super-core/`)**: An embedded SQLite (`node:sqlite` in WAL mode) evidence/provenance store implementing schema v5, mapping claims, evidence anchors, conflict resolution, anti-patterns, and experience graphs.\n7. **Site Clone & Synthesis Engine (`packages/site-clone/`)**: A complete reverse-engineering and compilation pipeline that parses live DOM trees into an Intermediate Representation (`CloneIR`) and compiles production Haravan Liquid themes or standalone offline bundles.\n\n---\n\n## 2. Subsystems & Key Files\n\n### A. Electron Main Subsystems (`src/main/`)\n- `src/main/index.ts`: Application composition root; configures crash dump reporting, single instance locking, profile ownership leasing (`ProfileOwnership`), window creation, WebContentsView layering, ControlPlaneRuntime initialization, deferred BridgeServer startup, and multi-step graceful shutdown.\n- `src/main/browser/native-tab-host.ts`: Central tab host (7,600 lines); manages browser views, multi-tab lifecycle, bookmarks, docked DevTools, Split Review dual-pane rendering, DPR and device presets, isolated-world JS execution (`ISOLATED_AGENT_WORLD_ID`), agent kinematics, and render surface stability gates.\n- `src/main/browser/terminal-manager.ts`: Canonical terminal manager; spawns Node-PTY processes (`powershell.exe`, `cmd.exe`, `bash`), injects bridge credentials into child environments, maintains `SessionDeliveryJournal` (2MB/4096-chunk bounded ring buffer) with sequence ACK protocols, and terminates process trees cleanly via `taskkill /T /F`.\n- `src/main/browser/split-review-coordinator.ts`: Manages side-by-side dual WebContentsViews for Desktop and Mobile presets; features `SplitNavigationCoordinator` to maintain URL parity without echo loops.\n- `src/main/browser/tab-automation-host.ts`: Drives smooth pointer trajectory kinematics, click/hover/type/scroll gestures, drag-and-drop actions, file uploads, and atomic action sequences.\n- `src/main/browser/tab-devtools-host.ts`: Manages direct Chrome DevTools Protocol (CDP) client attachments, command queuing, and execution domains.\n- `src/main/browser/semantic-ref-registry.ts`: Maintains monotonic `@e1..@eN` accessible references mapped to DOM element bounding rects and selectors, detecting DOM mutations and staleness.\n- `src/main/browser/tracker-isolation.ts`: Implements ephemeral network isolation that blocks third-party trackers, analytics, and noise during automated verification passes.\n- `src/main/browser/profile-ownership.ts`: Guards Chromium user data directory against concurrent process corruption using filesystem leases, PID checks, and clean shutdown markers.\n- `src/main/browser/browser-session-partition.ts`: Configures isolated Chromium session partitions, HTTP headers, cache ceilings (128MB disk, 64MB media), and user-agent emulation.\n- `src/main/control-plane/control-plane-runtime.ts`: Central orchestration hub binding ProjectRegistry, WorkspaceRegistry, ChatStore, RunService, EventStore, ReceiptStore, InvocationLedger, ArtifactStore, and CapabilityCatalogue.\n- `src/main/tools/capability-catalogue.ts`: Authoritative registry for all system capabilities; enforces risk levels, effect policies (`read`, `idempotent-write`, `destructive-mutation`), scheduler lanes, timeouts, and required argument validation.\n- `src/main/tools/browser-control-port.ts`: Mediates between capability requests and `NativeTabHost`, enforcing viewport gates, document generations, and target validation.\n- `src/main/tools/artifact-store.ts`: Manages content-addressed storage (`.artifact` staging) with SHA-256 integrity verification, byte limits, and automated retention cleaning.\n- `src/main/tools/workspace-file-port.ts`: Safe workspace filesystem port enforcing path traversal guards, boundary confinement, and size limits.\n- `src/main/tools/capability-transport.ts`: Handles bidirectional translation between client invocation intents and internal capability execution.\n- `src/main/bridge/bridge-server.ts`: Local WebSocket RPC server with pairing codes, grant tokens, DACL access control, mobile remote HTML streaming, and terminal multiplexing.\n- `src/main/native-messaging/local-ipc-server.ts`: Windows named-pipe IPC server bridging Chrome/Edge companion extension to the desktop application.\n- `src/main/native-messaging/manifest-installer.ts`: Auto-registers native messaging host manifests in Windows Registry for Chromium-based browsers.\n- `src/main/session/invocation-ledger.ts`: Append-only journal tracking capability execution states (`claiming`, `in_progress`, `completed`, `failed`), parameter digests, and recovery reconciliations.\n- `src/main/session/receipt-store.ts`: Cryptographically signs and persists delivery receipts binding commands, prompt digests, and host epochs.\n- `src/main/session/event-store.ts`: Structured JSON-lines logger recording session lifecycle events and state transitions.\n- `src/main/run/run-service.ts`: Manages execution runs, attempt lifecycles, backend session references, and prompt digests.\n- `src/main/run/attachment-registry.ts`: Issues and validates ephemeral agent credentials, lease tokens, and offscreen agent tab attachments.\n- `src/main/qa/theme-qa-workflow.ts`: Master e-commerce QA orchestrator running differential multi-scanner audits across 8 matrix dimensions and 3 viewports.\n- `src/main/qa/theme-transaction-registry.ts`: Coordinates transactional file mutations, disk snapshots, and atomic rollbacks.\n- `src/main/qa/theme-mutation-session.ts`: Manages developer mutation sessions with file touched-path limits and diff budgets.\n- `src/main/qa/scanners/platform-detector.ts`: Identifies e-commerce platform footprints (Haravan, Shopify, Sapo) from DOM and script assets.\n- `src/main/qa/scanners/liquid-error-scanner.ts`: Parses HTML output for Liquid compilation exceptions, missing templates, and DotLiquid crashes.\n- `src/main/qa/scanners/layout-overflow-engine.ts`: Measures layout geometry across viewports to detect horizontal scrollbars and clipped content.\n- `src/main/qa/scanners/broken-asset-scanner.ts`: Audits network requests to detect 404 images, dead fonts, and failed CDN dependencies.\n- `src/main/qa/scanners/server-crash-scanner.ts`: Flags HTTP 500 responses, .NET stack traces, and unhandled server errors.\n- `src/main/qa/rules/hs-gate-rules.ts`: Evaluates compliance against Sapo/Haravan migration rules (HS1 through HS26).\n- `src/main/qa/haravan-sync-barrier.ts`: Synchronization barrier that monitors file-watcher output in terminal shells before initiating verification.\n- `src/main/verification/verification-evaluator.ts`: Evaluates verification claims against collected evidence bundles, enforcing freshness and metric completeness.\n- `src/main/verification/visual-capture.ts`: Coordinates viewport and full-page screenshot acquisition, canvas tile stitching, and PNG staging.\n- `src/main/verification/capture-settle.ts`: Settle barrier waiting for network quiescence, DOM stabilization, and CSS animation quiescence.\n- `src/main/verification/baseline-authority.ts`: Tracks authorized baseline screenshots and computes structural/pixel diff percentages.\n- `src/main/device/device-manager.ts`: Enumerates connected iOS hardware via usbmuxd, maintaining independent `deviceEpoch` and `sessionGeneration` counters.\n- `src/main/device/ios-device-adapter.ts`: Adapts iOS device actions (Safari navigation, taps, swipes, typing, screenshots) to Control Plane contracts.\n- `src/main/device/wda-rest-client.ts`: Communicates with WebDriverAgent over HTTP/JSON for real iOS panel interaction.\n- `src/main/device/usbmux-client.ts`: Low-level binary protocol client connecting to local usbmuxd service (`127.0.0.1:27015`).\n\n### B. Presentation & Preload Layer (`src/renderer/`, `src/preload/`)\n- `src/preload/toolbar-preload.ts`: Preload script exposing safe `window.antifanToolbar` contextBridge APIs for navigation, tab management, DevTools, bookmarks, and Theme QA runs.\n- `src/preload/standalone-preload.ts`: Preload script exposing `window.antifanStandalone` contextBridge APIs for Node-PTY terminal streaming, split sessions, popout management, and workspace capsules.\n- `src/preload/tab-preload.ts`: Injected tab preload providing coordinate translations, element picking overlays, and DOM mutation hooks.\n- `src/preload/frame-backdrop-preload.ts`: Preload handling layout borders, drag regions, and theme accents for docked views.\n- `src/renderer/toolbar.ts`: Renderer controller for the browser toolbar, omnibox, device preset selectors, zoom, and split-review controls.\n- `src/renderer/standalone.js`: Cockpit renderer integrating xterm.js, terminal split panes, workspace capsule selectors, and session renames.\n- `src/renderer/frame-backdrop.ts`: Backdrop layout renderer managing dock split sizing and visual separation lines.\n\n### C. Shared Contracts & Protocols (`src/shared/`)\n- `src/shared/control-plane-contracts.ts`: Canonical schema definitions for entities, leases, `CapabilityEffectPolicy`, error codes (`CapabilityErrorCode`), invocation receipts, and B-Lite v2 loop lifecycle contracts.\n- `src/shared/contracts.ts`: IPC channels (`TOOLBAR_CHANNELS`, `TERMINAL_CHANNELS`), tab interfaces, split pane models, and terminal ACK structures.\n- `src/shared/device-control-contracts.ts`: Hardware device definitions, WDA status flags, device targets, and remediation codes.\n- `src/shared/theme-task-context.ts`: Contracts for theme fix loops: `FixRequestV2`, `FixResultV2`, diff budgets, allowed file lists, and decision enums.\n\n### D. Monorepo Packages (`packages/`)\n- `packages/super-core/src/index.ts`: Super Core engine; local SQLite store for Work Root artifacts, claims, evidence, decisions, conflicts, lineage, and experience graphs.\n- `packages/super-core/src/schema.ts`: DDL schema (version 5) and SQL migrations for all SQLite tables and full-text search (`claims_fts`).\n- `packages/site-clone/src/index.ts`: Site clone pipeline entrypoint; bundles DOM parsing, blueprint extraction, asset harvesting, and Haravan theme compilation.\n- `packages/site-clone/src/models/clone-ir.ts`: Intermediate Representation schema defining sections, blocks, layouts, assets, and ecommerce state.\n- `packages/site-clone/src/generators/theme-compiler.ts`: Compiles Clone IR structures into Haravan flat-directory Liquid themes.\n- `packages/site-clone/src/generators/independent-html-clone-generator.ts`: Emits 100% offline-playable, self-contained HTML/CSS/JS websites with localized assets.\n- `packages/site-clone/src/qa/mutation-qa-harness.ts`: Evaluates clean tab state protocols, navigation stability, and mutation diffs during site cloning.\n- `packages/plugin-sdk/manifest-types.ts`: Declarative plugin SDK v1 types defining manifest permissions, isolated hooks, and site adapter boundaries.\n\n### E. MCP & Agent Entrypoints (`scripts/`)\n- `scripts/antifan-omp-mcp.cjs`: Standalone Node MCP stdio server translating stdio MCP JSON-RPC into authenticated WebSocket RPC calls to BridgeServer; runs in-process Super Core tools directly.\n- `scripts/antifan-agent.cjs`: Agent wrapper CLI; resolves bridge endpoints across environment pins and filesystem locations, acquires ephemeral attachment leases, spawns the child agent, and revokes credentials on exit.\n- `scripts/antifan-core.cjs`: CLI tool for querying and managing the local Super Core SQLite database.\n- `scripts/run-test-pipeline.mjs`: Central test pipeline runner executing static gates (`audit`, `plans:check`) and test suites (`compile`, `test:canary`, `test:fast`, `test:site-clone`, `test:integration`, `test:main`, `test:e2e`).\n\n### F. Themes & Verification Specs (`themes/`, `specs/`)\n- `themes/universal-haravan-base/`: Reference Haravan flat-directory theme template with DotLiquid snippets, layouts, and `settings_schema.json`.\n- `themes/roahtrip-haravan/`: Production Haravan theme structure featuring modular Liquid sections and localized configuration.\n- `specs/base-theme-contract.json`: Exhaustive 1,142-line specification detailing Haravan architecture style, DotLiquid filter restrictions, preview addressing (`?themeid=`), and API capabilities.\n- `specs/qa-matrix.json`: Benchmark specification defining the 8 evaluation dimensions and viewport mismatch thresholds (<10%).\n\n---\n\n## 3. Cross-Boundary Data Flows & Contracts\n\n### A. Agent Tool Invocation Flow (OMP -> MCP -> Bridge -> Control Plane -> Chromium)\n```\n[AI Agent (OMP / Claude)]\n       │  (stdio JSON-RPC: tools/call)\n       ▼\n[scripts/antifan-omp-mcp.cjs]\n       │  (WebSocket RPC / BridgeRequestPayload)\n       ▼\n[src/main/bridge/bridge-server.ts]\n       │  (CapabilityTransportAdapter)\n       ▼\n[src/main/control-plane/control-plane-runtime.ts]\n       │  (CapabilityCatalogue.dispatchAuthenticated)\n       ├──> [Policy & Arg Validation: validateAndFreezePolicy + assertRequiredArgs]\n       ├──> [InvocationLedger: record in-flight execution frame]\n       ▼\n[src/main/tools/browser-control-port.ts]\n       │  (Generation & Viewport Gates)\n       ▼\n[src/main/browser/native-tab-host.ts]\n       ├──> CDP Protocol Commands (TabDevToolsHost)\n       ├──> Isolated Script Injection (ISOLATED_AGENT_WORLD_ID)\n       └──> Native Input Kinematics (TabAutomationHost)\n       │\n       ▼  (Results & Artifact Staging)\n[src/main/tools/artifact-store.ts] (.artifact staged with SHA-256)\n       │\n       ▼  (AuthoritativeInvocationReceipt)\n[scripts/antifan-omp-mcp.cjs] ──> [AI Agent]\n```\n\n### B. Dual-Plane Isolation & Authority Contract\n- **User vs Agent Tab Isolation**: In dual-plane mode, background agent automation targets dedicated offscreen WebContentsView instances (`isTabOffscreen === true`). The user's active foreground tab is never hijacked or closed by an agent session.\n- **Attachment Lease & Generation Fencing**: Invocations carry `attachmentId`, `authorityRevision`, and expected `documentGeneration`. If navigation occurs between planning and execution, document generations mismatch and calls fail closed with `TARGET_STALE`.\n- **Pre-dispatch vs Post-dispatch Failure**: Read operations auto-sync if generation shifts; mutating operations fail immediately before applying any CDP or DOM side effects.\n\n### C. Tier-2 Hardware Device Control Flow\n- Physical iOS devices are discovered over USB multiplexer (`usbmuxd` on TCP 27015).\n- `DeviceManager` assigns an immutable `deviceEpoch` to the hardware connection and tracks `sessionGeneration` from WebDriverAgent.\n- `IosDeviceAdapter` executes Safari automation (taps, swipes, URL navigation) over WDA REST API, captures raw screen buffers, and stages them directly into `ArtifactStore`. Receipts enter `ReceiptStore` under the unified control plane contract.\n\n### D. Terminal Delivery Journal & Affinity Sync\n- Terminal PTY processes run in the Main process via `node-pty`.\n- Terminal output flows into `SessionDeliveryJournal`, which appends sequence-numbered chunks (`seq`, `generation`, `data`) up to 2MB or 4,096 entries.\n- UI renderers (`standalone.js`) consume chunks and send ACK payloads (`antifan:terminal:ack`).\n- Reconnecting clients request delta slices (`getTerminalDelta`), which are served from memory or re-hydrated from full buffer logs without data loss.\n\n---\n\n## 4. Unresolved Technical Questions & Architectural Risks\n\n1. **Canary Settle Gate Carousel Starvation (Bottleneck B19 - Open, P1)**:\n   - *Issue*: `canary-settle.mjs` and `capture-settle.ts` require a quiet DOM window of `quietFor >= 1500ms` within a 9000ms ceiling. On e-commerce storefronts with continuous auto-advancing carousels or CSS ticker animations, DOM mutation observers never observe 1500ms of quiet, causing settle timeouts.\n   - *Risk*: Theme verification fails inconclusive on animated storefront pages.\n2. **Full-Page Screenshot Tiling Ceiling (Bottleneck B20 - Open, P2)**:\n   - *Issue*: Chromium CDP `Page.captureScreenshot` has a hard 16,384px height limit. Capturing long e-commerce catalog pages requires manual viewport scrolling and main-thread canvas stitching in `src/main/verification/visual-capture.ts`.\n   - *Risk*: Long pages block the Electron event loop during canvas composite operations, leading to temporary UI freezes.\n3. **Shadowing MCP Capability Routing Rows (Bottleneck B29 - Open, P2)**:\n   - *Issue*: In `scripts/antifan-omp-mcp.cjs`, 23 `anti.*` routing rows redirect tool names that the server's `CapabilityCatalogue` already registers. Several `anti.*` aliases in the server catalogue are distinct implementations from the routed targets (e.g. window-wide vs session-scoped tab listing).\n   - *Risk*: Modifying or retiring proxy routing rows can unintentionally alter runtime tool semantics for agents relying on default arguments.\n4. **Visual Compare Normalization 15s Timeout (Bottleneck B30 - Open, P1)**:\n   - *Issue*: On complex, heavily scripted reference sites, `anti.visual.compare` reversible normalization apply exceeds its 15,000ms bound. When this occurs, `capture.valid` is marked false, and comparison cases resolve to `CAPTURE_INVALID` / `INCONCLUSIVE`.\n   - *Risk*: High-fidelity clone verification campaigns cannot automatically adjudicate visual parity on script-heavy pages.\n5. **Campaign Verdict Provenance Binding (Bottleneck B32 - Open, P1)**:\n   - *Issue*: Aggregated verdict ledgers (`_verdicts.json`) generated by multi-page campaigns occasionally record `exit`, `finishedAt`, or `routeIdentity` as null when aggregator scripts fail to pass runner state through.\n   - *Risk*: Inconclusive or non-revision-bound audit receipts cannot be machine-verified at HEAD, leaving room for unproven claims.\n6. **Electron Main Thread Saturation Under Heavy Agent Invocations**:\n   - *Issue*: Artifact hashing (SHA-256), JSON serialization of large DOM trees, and IPC message routing all execute within Electron's main process event loop.\n   - *Risk*: Intense agent inspection loops can cause latency spikes, delaying user input handling and toolbar rendering updates.",
  "architecture": "AntiFan Browser Desktop is architectured as a dual-plane Electron control plane for autonomous coding agents:\n1. Electron Main / Chromium TabHost: Hosts browser surfaces using multi-WebContentsView layering (Toolbar, WebContents, Split Desktop/Mobile, DevTools, and Standalone Terminal). Manages process partitions, isolated JS execution worlds (ISOLATED_AGENT_WORLD_ID), and synchronous CDP sessions.\n2. Control Plane Runtime & Capability Catalogue: Strictly enforces runtime leases, exact document generations, capability risk policies (read, write, execute, eval), idempotency keys, and crash/cancellation barriers.\n3. Bridge & Native Messaging: Provides OS-user authenticated WebSocket RPC (ports 20129/20130) and Windows named-pipe Local IPC to broker connections between external agents and the browser.\n4. Terminal Subsystem (Node-PTY): Single-instance TerminalManager with ring-buffer SessionDeliveryJournal (2MB/4096-chunk bound), tab-terminal affinity, and environment-injected credentials.\n5. Tier-2 Device Reality Gate: Hardware iOS USB automation via usbmuxd and WebDriverAgent REST client, tracking independent deviceEpoch and sessionGeneration lifecycles.\n6. Verification & Theme QA Engine: Multi-dimensional QA Matrix evaluating visual fidelity, DOM semantics, CSS modularity, and e-commerce platform rules (Haravan/Sapo/Shopify), with atomic snapshot staging and R0 rollback.\n7. Local Super Core: Embedded SQLite (node:sqlite WAL mode) tracking knowledge graphs, claims, evidence anchors, anti-patterns, and receipts.\n8. Site Clone & Theme Compiler: DOM extraction pipeline transforming live pages into Clone IR, independent HTML bundles, and production Haravan themes.",
  "files": [
    {
      "path": "src/main/index.ts",
      "description": "Electron main entrypoint bootstrapping single-instance lock, crash reporter, profile leases, window state, TabHost, ControlPlane, BridgeServer, and Local IPC."
    },
    {
      "path": "src/main/browser/native-tab-host.ts",
      "description": "Primary browser controller managing WebContentsViews, tab lifecycles, dual-pane Split Review, CDP debugging, pointer kinematics, and isolated-world execution."
    },
    {
      "description": "Central control plane runtime orchestrating capability catalogues, run attachments, file/artifact ports, invocation ledgers, and theme transaction registries.",
      "path": "src/main/control-plane/control-plane-runtime.ts"
    },
    {
      "path": "src/main/tools/capability-catalogue.ts",
      "description": "Strict capability policy enforcement registry validating effect policies, argument schemas, execution timeouts, scheduler lanes, and target liveness."
    },
    {
      "description": "High-level browser abstraction port mediating between capability dispatch and NativeTabHost for DOM inspection, evaluation, navigation, and visual captures.",
      "path": "src/main/tools/browser-control-port.ts"
    },
    {
      "path": "src/main/bridge/bridge-server.ts",
      "description": "Authenticated local WebSocket RPC server bridging external CLI/MCP agent processes to the Control Plane Runtime and terminal streams."
    },
    {
      "description": "Terminal manager orchestrating Node-PTY shell sessions, process trees, split panes, tab affinity, and bounded sequence delivery journals.",
      "path": "src/main/browser/terminal-manager.ts"
    },
    {
      "path": "src/main/browser/split-review-coordinator.ts",
      "description": "Dual-surface desktop/mobile split-review coordinator managing synchronized navigations, view layout geometries, and pane presets."
    },
    {
      "description": "Agent automation host driving native pointer trajectories, click/type gestures, file upload dropzones, and monotonic @ref DOM snapshots.",
      "path": "src/main/browser/tab-automation-host.ts"
    },
    {
      "path": "src/main/browser/tab-devtools-host.ts",
      "description": "CDP DevTools host managing Chrome DevTools Protocol client sessions, message queues, and script evaluators."
    },
    {
      "description": "Registry maintaining monotonic @e1..@eN references, bounding DOM snapshots, and tracking element stability across re-renders.",
      "path": "src/main/browser/semantic-ref-registry.ts"
    },
    {
      "path": "src/main/browser/tracker-isolation.ts",
      "description": "Ephemeral tracker isolation barrier blocking third-party telemetry domains during verification capture to eliminate test noise."
    },
    {
      "path": "src/main/browser/profile-ownership.ts",
      "description": "Chromium persistent profile lease coordinator preventing dual-process profile corruption and handling safe start recovery."
    },
    {
      "description": "Session partition manager configuring cookie stores, web security policies, cache ceilings, and custom user agents.",
      "path": "src/main/browser/browser-session-partition.ts"
    },
    {
      "path": "src/main/tools/artifact-store.ts",
      "description": "Content-addressed, retention-managed local artifact store staging screenshots, DOM dumps, and verification receipts with quota bounds."
    },
    {
      "description": "Workspace-scoped filesystem access port enforcing workspace directory boundaries, symlink reparse rejections, and size limits.",
      "path": "src/main/tools/workspace-file-port.ts"
    },
    {
      "description": "Bidirectional transport adapter routing client invocation intents into authenticated capability dispatch.",
      "path": "src/main/tools/capability-transport.ts"
    },
    {
      "path": "src/main/native-messaging/local-ipc-server.ts",
      "description": "Windows named-pipe Local IPC server facilitating native messaging authentication handshakes for browser companion extensions."
    },
    {
      "description": "Native messaging host manifest installer for Chrome, Edge, and Brave browsers on Windows.",
      "path": "src/main/native-messaging/manifest-installer.ts"
    },
    {
      "description": "Append-only persistent invocation ledger recording in-flight, completed, and terminal capability execution frames with SHA-256 digests.",
      "path": "src/main/session/invocation-ledger.ts"
    },
    {
      "description": "Durable receipt store persisting immutable cryptographic execution receipts and delivery states.",
      "path": "src/main/session/receipt-store.ts"
    },
    {
      "path": "src/main/session/event-store.ts",
      "description": "Structured JSON-lines event store logging lifecycle transitions, window events, and agent milestones."
    },
    {
      "path": "src/main/run/run-service.ts",
      "description": "Run lifecycle coordinator tracking execution attempts, backend session refs, and prompt digests."
    },
    {
      "description": "Attachment registry issuing and verifying ephemeral agent credentials, lease tokens, and target tab bindings.",
      "path": "src/main/run/attachment-registry.ts"
    },
    {
      "description": "End-to-end theme verification workflow executing multi-scanner checks across 8 QA matrix dimensions and 3 viewports.",
      "path": "src/main/qa/theme-qa-workflow.ts"
    },
    {
      "description": "Transactional theme mutation registry managing workspace file snapshots, pre-merge validation, and R0 rollback safety gates.",
      "path": "src/main/qa/theme-transaction-registry.ts"
    },
    {
      "description": "Theme mutation session coordinator tracking staged workspace changes, diff budgets, and verification cycles.",
      "path": "src/main/qa/theme-mutation-session.ts"
    },
    {
      "description": "E-commerce storefront platform detector identifying Haravan, Shopify, and Sapo footprints and architectures.",
      "path": "src/main/qa/scanners/platform-detector.ts"
    },
    {
      "path": "src/main/qa/scanners/liquid-error-scanner.ts",
      "description": "Liquid error scanner detecting DotLiquid compilation crashes, missing snippets, syntax errors, and dump leaks."
    },
    {
      "path": "src/main/qa/scanners/layout-overflow-engine.ts",
      "description": "Layout overflow scanner measuring horizontal scrolling, negative margins, and responsive viewport clipping."
    },
    {
      "path": "src/main/qa/scanners/broken-asset-scanner.ts",
      "description": "Broken asset scanner identifying 404 image URLs, missing CSS/JS files, and CDN host failures."
    },
    {
      "path": "src/main/qa/scanners/server-crash-scanner.ts",
      "description": "Server crash scanner detecting HTTP 500 responses, .NET runtime exceptions, and web server crashes."
    },
    {
      "path": "src/main/qa/rules/hs-gate-rules.ts",
      "description": "Rule engine evaluating compliance with Haravan/Sapo HS1–HS26 architectural specifications."
    },
    {
      "description": "Synchronization barrier settling local-to-remote file watcher propagation before running verification checks.",
      "path": "src/main/qa/haravan-sync-barrier.ts"
    },
    {
      "description": "Authoritative verification evaluator checking proof obligations, metric tolerances, and document freshness barriers.",
      "path": "src/main/verification/verification-evaluator.ts"
    },
    {
      "description": "Visual capture engine performing viewport and full-page screenshot acquisitions, composite tiling, and PNG encoding.",
      "path": "src/main/verification/visual-capture.ts"
    },
    {
      "path": "src/main/verification/capture-settle.ts",
      "description": "Visual capture settle coordinator waiting for network quiescence, DOM mutations, and RAF rendering stability."
    },
    {
      "description": "Authority manager maintaining verified reference baselines and detecting drift or tampering.",
      "path": "src/main/verification/baseline-authority.ts"
    },
    {
      "path": "src/main/device/device-manager.ts",
      "description": "Physical iOS device registry managing USB enumeration via usbmuxd, attachment epochs, and session generations."
    },
    {
      "path": "src/main/device/ios-device-adapter.ts",
      "description": "iOS device adapter implementing DeviceControlPort via WebDriverAgent REST client and artifact store staging."
    },
    {
      "description": "REST client driving WebDriverAgent on iOS devices for Safari automation, taps, swipes, inputs, and screenshots.",
      "path": "src/main/device/wda-rest-client.ts"
    },
    {
      "path": "src/main/device/usbmux-client.ts",
      "description": "Low-level usbmuxd TCP client communicating over USB multiplexer protocol for device discovery and port forwarding."
    },
    {
      "path": "src/preload/toolbar-preload.ts",
      "description": "Preload script exposing window.antifanToolbar for tab manipulation, navigation, DevTools, bookmarks, and QA actions."
    },
    {
      "path": "src/preload/standalone-preload.ts",
      "description": "Preload script exposing window.antifanStandalone for terminal stream synchronization, splits, popouts, and workspace capsules."
    },
    {
      "description": "Preload script injected into web pages providing element picking, coordinate translation, and DOM observation hooks.",
      "path": "src/preload/tab-preload.ts"
    },
    {
      "description": "Preload script for the auxiliary frame backdrop managing layout borders and focus states.",
      "path": "src/preload/frame-backdrop-preload.ts"
    },
    {
      "path": "src/renderer/toolbar.ts",
      "description": "Renderer script for top navigation toolbar, omnibox, device preset selectors, and split-review triggers."
    },
    {
      "path": "src/renderer/standalone.js",
      "description": "Renderer script for terminal cockpit, workspace capsule switcher, and multi-session xterm integration."
    },
    {
      "description": "Renderer script for the desktop frame backdrop handling visual accents and docking boundaries.",
      "path": "src/renderer/frame-backdrop.ts"
    },
    {
      "path": "src/shared/control-plane-contracts.ts",
      "description": "Comprehensive shared contracts defining control plane entities, capability policies, lease tokens, and error codes."
    },
    {
      "path": "src/shared/contracts.ts",
      "description": "Shared UI and IPC channel definitions, tab models, split pane presets, and terminal ACK contracts."
    },
    {
      "description": "Shared physical device contracts, WDA status flags, and remediation codes.",
      "path": "src/shared/device-control-contracts.ts"
    },
    {
      "path": "src/shared/theme-task-context.ts",
      "description": "Shared theme task context interfaces for diff budgets, allowed files, and fix lifecycle states."
    },
    {
      "description": "Super Core engine implementing local-first SQLite evidence store, claim indexation, and context pack generation.",
      "path": "packages/super-core/src/index.ts"
    },
    {
      "path": "packages/super-core/src/schema.ts",
      "description": "Super Core DDL schema and migrations defining artifacts, claims, evidence, lineage, conflicts, and experience graphs."
    },
    {
      "description": "Site clone entrypoint re-exporting DOM parsers, blueprint extractors, asset harvesters, and theme compilers.",
      "path": "packages/site-clone/src/index.ts"
    },
    {
      "path": "packages/site-clone/src/models/clone-ir.ts",
      "description": "Intermediate Representation (IR) schema and builder for parsed e-commerce site components, layouts, and assets."
    },
    {
      "description": "Theme compiler transforming Clone IR models into complete, production-ready Haravan theme directories.",
      "path": "packages/site-clone/src/generators/theme-compiler.ts"
    },
    {
      "path": "packages/site-clone/src/generators/independent-html-clone-generator.ts",
      "description": "Generator producing 100% standalone, offline-playable HTML/CSS/JS clone packages with localized subresources."
    },
    {
      "description": "Mutation QA harness verifying clean tab states, navigation stability, and interaction parity.",
      "path": "packages/site-clone/src/qa/mutation-qa-harness.ts"
    },
    {
      "description": "Plugin SDK v1 public types defining plugin manifests, permissions, hooks, and isolated site adapter schemas.",
      "path": "packages/plugin-sdk/manifest-types.ts"
    },
    {
      "path": "scripts/antifan-omp-mcp.cjs",
      "description": "Standalone Model Context Protocol (MCP) stdio server proxying tool invocations to Bridge WebSocket and local Super Core."
    },
    {
      "description": "Agent CLI launcher wrapping AI coding agents (OMP, Claude, Codex) with ephemeral bridge attachment credentials.",
      "path": "scripts/antifan-agent.cjs"
    },
    {
      "path": "scripts/antifan-core.cjs",
      "description": "CLI tool for Super Core operations: query, context packs, recommendations, outcome ingestion, and adjudication."
    },
    {
      "description": "Aggregate test pipeline runner executing static audits, canary lanes, unit, site-clone, integration, main, and e2e tests.",
      "path": "scripts/run-test-pipeline.mjs"
    },
    {
      "description": "Exhaustive machine-readable architectural specification of Haravan Flat Directory V1 Liquid dialect and platform boundaries.",
      "path": "specs/base-theme-contract.json"
    },
    {
      "description": "Canonical 8-dimension QA verification matrix specification across desktop, tablet, and mobile viewports.",
      "path": "specs/qa-matrix.json"
    },
    {
      "path": "plans/bottlenecks.json",
      "description": "Machine-checkable closure ledger tracking architectural bottlenecks, regression predicates, and open technical debt."
    }
  ],
  "summary": "AntiFan Browser Desktop (v1.3.6) is an Electron-based local control plane and visual companion for AI agent workflows. It combines a multi-view Chromium tab host (with dual-surface desktop/mobile Split Review), an authenticated WebSocket bridge, an in-process SQLite Super Core store, Node-PTY terminal management, an iOS USB hardware automation adapter, an e-commerce Theme QA engine, and a Site Clone compiler."
}