<!-- Ultra Verifier source material. Anonymized candidate B. -->
<!-- Controller-private mapping: B = Candidate1. Self-ratings stripped before judging. -->
<!-- NOTE: 7 paths in these raw reports failed controller validation and were dropped/corrected -->
<!-- in the materialized union (plans/reports/scout-union-260915-full-codebase-ultra.md §0.2). -->

{
  "summary": "Executed Ultra Verifier Mode codebase scout across AntiFan Browser Desktop (v1.3.6). Completed a deep, evidence-backed architectural analysis covering Electron Main subsystems, Presentation/Preload layers, Shared Contracts, Monorepo Packages (super-core, site-clone, plugin-sdk), MCP/Agent entrypoints, Theme Specs, Test Architecture, and Plans/Bottlenecks. Mapped cross-boundary data flows (Dual-Plane Isolation, Tier-2 iOS Hardware WDA integration, Theme Transactions, Settle Gates) and detailed all active bottlenecks (B19, B20, B21, B23, B29, B30, B32) and architectural risks.",
  "files": [
    {
      "description": "Electron main process bootstrap, crash reporting, single-instance lock, and subsystem wiring.",
      "path": "src/main/index.ts"
    },
    {
      "description": "WebContentsView tab manager, split desktop/mobile review, DevTools docking, and browser state.",
      "path": "src/main/browser/native-tab-host.ts"
    },
    {
      "path": "src/main/browser/terminal-manager.ts",
      "description": "PTY process coordinator (node-pty/ConPTY) with delivery journal, ack synchronization, and bridge affinity."
    },
    {
      "description": "Synthetic gesture execution (click, drag, type, scroll) and isolated agent cursor overlay driver.",
      "path": "src/main/browser/tab-automation-host.ts"
    },
    {
      "description": "CDP session manager, responsive matrix emulators, and full-page/viewport screenshot engine.",
      "path": "src/main/browser/tab-devtools-host.ts"
    },
    {
      "description": "Monotonic semantic element reference registry (@e1..@eN) with document-generation barriers.",
      "path": "src/main/browser/semantic-ref-registry.ts"
    },
    {
      "description": "Isolated JavaScript collector/executor injecting into isolated script worlds to prevent target page contamination.",
      "path": "src/main/browser/semantic-ref-executor.ts"
    },
    {
      "description": "Temporary vendor tracker blocking and network isolation window during QA assertions.",
      "path": "src/main/browser/tracker-isolation.ts"
    },
    {
      "path": "src/main/browser/zero-network-interceptor.ts",
      "description": "Strict offline request interceptor guaranteeing zero external network leaks during offline runs."
    },
    {
      "path": "src/main/browser/profile-ownership.ts",
      "description": "Single-owner profile lease manager with crash detection, recovery markers, and lock files."
    },
    {
      "description": "Dual-surface desktop/mobile split-view coordinator and synchronization state machine.",
      "path": "src/main/browser/split-review-coordinator.ts"
    },
    {
      "path": "src/main/tools/capability-catalogue.ts",
      "description": "Central 176-capability registry enforcing frozen execution policies, tenancy, and dispatch locks."
    },
    {
      "path": "src/main/tools/browser-control-port.ts",
      "description": "Typed facade exposing tab management, navigation, evaluation, and DOM querying to the control plane."
    },
    {
      "description": "Browser capability registrations for tabs, screenshots, styling, DOM dumps, and gestures.",
      "path": "src/main/tools/browser-capabilities.ts"
    },
    {
      "description": "Physical iOS device capability family exposing WDA-driven Safari automation and native taps.",
      "path": "src/main/tools/device-capabilities.ts"
    },
    {
      "description": "Core evidence store capability registrations exposing Super Core queries, packs, and receipts.",
      "path": "src/main/tools/core-capabilities.ts"
    },
    {
      "description": "Path-contained workspace file read/write capabilities with boundary enforcement.",
      "path": "src/main/tools/file-capabilities.ts"
    },
    {
      "path": "src/main/tools/terminal-capabilities.ts",
      "description": "Terminal lifecycle, stream subscription, resize, and command execution capabilities."
    },
    {
      "path": "src/main/tools/theme-transaction-capabilities.ts",
      "description": "Atomic theme transaction capabilities (begin, write_files, commit, rollback) with R0 snapshots."
    },
    {
      "description": "Content-addressed storage (CAS) for screenshots, DOM snapshots, logs, and audit reports.",
      "path": "src/main/tools/artifact-store.ts"
    },
    {
      "description": "Deterministic verification engine adjudicating claims against fresh mechanical evidence bundles.",
      "path": "src/main/verification/verification-evaluator.ts"
    },
    {
      "description": "Types, interfaces, and violation codes for claims, evidence bundles, and proof profiles.",
      "path": "src/main/verification/verification-contract.ts"
    },
    {
      "description": "Raster geometry mapping, pixel-level diffing, and fail-closed mask ledger (<70% area ratio).",
      "path": "src/main/verification/visual-capture.ts"
    },
    {
      "path": "src/main/verification/visual-region.ts",
      "description": "Spatial region inspector and structural layout component metrics extractor."
    },
    {
      "path": "src/main/verification/capture-settle.ts",
      "description": "Composed 4-stage settle barrier (network quiescence, fonts ready, images decoded, DOM quiet)."
    },
    {
      "path": "src/main/qa/theme-qa-workflow.ts",
      "description": "Master orchestrator for multi-scanner theme QA, regression differential analysis, and gating."
    },
    {
      "description": "Coordinated auto-repair engine executing transactional diffs with automatic R0 rollback.",
      "path": "src/main/qa/theme-qa-repair-coordinator.ts"
    },
    {
      "description": "Transactional workspace mutation session tracking CAS writes, generations, and rollback states.",
      "path": "src/main/qa/theme-mutation-session.ts"
    },
    {
      "description": "Haravan/DotLiquid vs Shopify/Sapo platform heuristic detector and theme architecture classifier.",
      "path": "src/main/qa/scanners/platform-detector.ts"
    },
    {
      "description": "DotLiquid syntax error scanner identifying forbidden filters and invalid tags in Liquid templates.",
      "path": "src/main/qa/scanners/liquid-error-scanner.ts"
    },
    {
      "path": "src/main/qa/scanners/server-crash-scanner.ts",
      "description": "Node/Theme crash and uncaught server exception detector."
    },
    {
      "path": "src/main/qa/scanners/broken-asset-scanner.ts",
      "description": "Broken image and missing asset scanner validating HTTP status and dimensions across viewports."
    },
    {
      "description": "Horizontal viewport overflow and layout blowout detector probing at standard responsive widths.",
      "path": "src/main/qa/scanners/layout-overflow-engine.ts"
    },
    {
      "path": "src/main/qa/rules/hs-gate-rules.ts",
      "description": "Sapo/Haravan compliance gate rules (Mailchimp, /postcontact, deleteAddress, slice LINQ dump)."
    },
    {
      "description": "Physical iOS device lifecycle manager maintaining monotonic device epochs across re-plugs.",
      "path": "src/main/device/device-manager.ts"
    },
    {
      "description": "Serialized Tier-2 iOS execution adapter coordinating WDA calls and screenshot artifact staging.",
      "path": "src/main/device/ios-device-adapter.ts"
    },
    {
      "path": "src/main/device/wda-rest-client.ts",
      "description": "WebDriverAgent REST API client handling session creation, element clicks, keystrokes, and screens."
    },
    {
      "description": "Hand-rolled dependency-free usbmuxd XML plist client communicating over local USB multiplexer.",
      "path": "src/main/device/usbmux-client.ts"
    },
    {
      "description": "TCP forwarder multiplexing local loopback ports through usbmuxd to the attached iPhone.",
      "path": "src/main/device/usbmux-forwarder.ts"
    },
    {
      "path": "src/main/device/device-readiness.ts",
      "description": "Tri-state gate evaluator determining USB attachment, pairing, Developer Mode, and WDA readiness."
    },
    {
      "description": "WebSocket server bridging local AI agents/MCP tools to the live Electron Chromium instance.",
      "path": "src/main/bridge/bridge-server.ts"
    },
    {
      "description": "Visual annotation and user feedback manager linking screenshot coordinates to agent context.",
      "path": "src/main/bridge/annotation-manager.ts"
    },
    {
      "description": "Core runtime coordinator managing workspace leases, attachment lifecycles, and capabilities.",
      "path": "src/main/control-plane/control-plane-runtime.ts"
    },
    {
      "path": "src/main/session/invocation-ledger.ts",
      "description": "Append-only write-ahead log for capability invocations with checksums and crash reconciliation."
    },
    {
      "description": "Durable decision and verification receipt repository preserving historical evidence.",
      "path": "src/main/session/receipt-store.ts"
    },
    {
      "description": "Chronological event stream store recording cross-subsystem lifecycle occurrences.",
      "path": "src/main/session/event-store.ts"
    },
    {
      "path": "src/main/session/issue-register.ts",
      "description": "Auditable issue tracker recording verified defects, severity, and remediation state."
    },
    {
      "path": "src/main/session/run-recovery.ts",
      "description": "Crash detection and recovery orchestrator reconstructing uncommitted state after unexpected termination."
    },
    {
      "description": "Declarative multi-step browser automation workflow executor.",
      "path": "src/main/workflow/workflow-engine.ts"
    },
    {
      "description": "Custom antifan-preview:// protocol handler serving isolated local workspace assets safely.",
      "path": "src/main/server/preview-protocol-handler.ts"
    },
    {
      "path": "src/main/server/safe-fs-resolver.ts",
      "description": "Filesystem path traversal sanitizer and MIME detector ensuring sandboxed file streaming."
    },
    {
      "description": "Strict navigation origin and CSP policy validator preventing cross-origin privilege escalation.",
      "path": "src/main/security/security-policy.ts"
    },
    {
      "path": "src/main/native-messaging/local-ipc-server.ts",
      "description": "Windows Named Pipe IPC server enabling native messaging communication with Chrome extensions."
    },
    {
      "description": "Chrome/Edge/Brave Windows registry installer for companion extension host manifests.",
      "path": "src/main/native-messaging/manifest-installer.ts"
    },
    {
      "path": "src/main/diagnostics/main-lifecycle-log.ts",
      "description": "Synchronous on-disk lifecycle journaling logging boot, heartbeat, and fatal exit milestones."
    },
    {
      "description": "Deterministic cross-platform storage directory paths for runtime, config, data, and cache.",
      "path": "src/main/config/storage-locations.ts"
    },
    {
      "path": "src/main/project/workspace-capsule.ts",
      "description": "Multi-project isolated workspace container manager preserving partitions and preview origins."
    },
    {
      "description": "Client UI script for the browser toolbar (tabs, presets, URL omnibox, inspect, QA).",
      "path": "src/renderer/toolbar.ts"
    },
    {
      "path": "src/renderer/standalone.js",
      "description": "Standalone HTML clone and visual artifact viewer script."
    },
    {
      "path": "src/preload/toolbar-preload.ts",
      "description": "Electron contextBridge exposing secure typed IPC channels to the toolbar renderer."
    },
    {
      "description": "In-tab preload providing anti-detection navigator properties and Haravan auto-JSON formatting.",
      "path": "src/preload/tab-preload.ts"
    },
    {
      "description": "Master control plane contracts, capability policies, lease types, and error classifications.",
      "path": "src/shared/control-plane-contracts.ts"
    },
    {
      "description": "Shared data contracts for tabs, picked elements, split-pane layouts, and bridge events.",
      "path": "src/shared/contracts.ts"
    },
    {
      "path": "src/shared/theme-task-context.ts",
      "description": "Theme task context contracts, CAS write shapes, and verification transaction receipts."
    },
    {
      "path": "src/shared/device-control-contracts.ts",
      "description": "Physical device target, binding, readiness gates, and error remediation contracts."
    },
    {
      "path": "packages/super-core/src/index.ts",
      "description": "Local SQLite evidence engine managing claims, context packs, recommendations, and decisions."
    },
    {
      "description": "Database schema DDL, FTS tables, and SQLite migrations for Super Core evidence storage.",
      "path": "packages/super-core/src/schema.ts"
    },
    {
      "path": "packages/site-clone/src/models/clone-ir.ts",
      "description": "Intermediate representation schema for UI components, layout structures, and styling."
    },
    {
      "path": "packages/site-clone/src/models/dom-tree-parser.ts",
      "description": "Parser transforming raw HTML/DOM trees into normalized ComponentContractIR structures."
    },
    {
      "description": "Downloader and rewriter localizing external images, stylesheets, and fonts into offline assets.",
      "path": "packages/site-clone/src/models/asset-localizer.ts"
    },
    {
      "description": "Orchestrator compiling CloneIR into production-ready Haravan flat-directory DotLiquid themes.",
      "path": "packages/site-clone/src/generators/theme-compiler.ts"
    },
    {
      "description": "Generator producing 100% offline self-contained HTML clone bundles with zero remote requests.",
      "path": "packages/site-clone/src/generators/independent-html-clone-generator.ts"
    },
    {
      "path": "packages/site-clone/src/qa/mutation-qa-harness.ts",
      "description": "Regression harness verifying layout stability and interactive state transitions under mutation."
    },
    {
      "path": "packages/site-clone/src/qa/clean-tab-probe.ts",
      "description": "Deterministic interaction validator asserting hover menus, modals, and sliders without flakiness."
    },
    {
      "description": "Standalone stdio MCP proxy exposing AntiFan capabilities to OMP, Claude Code, and Cursor.",
      "path": "scripts/antifan-omp-mcp.cjs"
    },
    {
      "path": "scripts/antifan-agent.cjs",
      "description": "CLI wrapper spawning AI agents with ephemeral bridge attachment leases and port pins."
    },
    {
      "path": "scripts/antifan-core.cjs",
      "description": "CLI interface to query, pack, recommend, and adjudicate Super Core evidence."
    },
    {
      "description": "Compile-time check enforcing that the MCP client ceiling strictly dominates all capability timeouts.",
      "path": "scripts/check-mcp-budget-dominance.mjs"
    },
    {
      "description": "Multi-lane test pipeline runner executing static, canary, fast, integration, and e2e suites.",
      "path": "scripts/run-test-pipeline.mjs"
    },
    {
      "description": "Authoritative contract specifying Haravan DotLiquid engine limits, paths, and platform rules.",
      "path": "specs/base-theme-contract.json"
    },
    {
      "description": "Evaluation matrix defining scoring formulas and tolerances across 8 theme dimensions.",
      "path": "specs/qa-matrix.json"
    },
    {
      "description": "Machine-checkable defect ledger tracking closure status, predicates, and open bottlenecks.",
      "path": "plans/bottlenecks.json"
    }
  ],
  "report": "# AntiFan Browser Desktop — Comprehensive Ultra Scout Architectural Report\n\n**Target Version:** v1.3.6  \n**Evaluation Mode:** Ultra Verifier Best-of-5 Scout Pass (`Candidate 1`)  \n**Workspace Root:** `C:/Users/Admin/AppData/Local/Temp/antifan-head`  \n**Host Environment:** Windows 11 Pro x64 (Win32 10.0.22000), Intel Core i5-9300H CPU @ 2.40GHz, Node.js + Electron 43.4.0  \n**Verification Baseline:** Grounded against committed workspace state, live test runners, build invariants, and closed/open bottleneck ledgers.\n\n---\n\n## 1. Executive Architecture Summary\n\nAntiFan Browser Desktop (`antifan-browser-desktop`) is an ultra-hardened, high-performance **Local Control Plane & Dual-Surface Companion** purpose-built for AI Agent workflows (OMP, Claude Code, Cursor, Antigravity IDE). Operating at the intersection of local GUI inspection, headless browser automation, real physical device testing, and ecommerce storefront engineering, it provides:\n\n1. **Dual-Plane Authority Architecture:** Completely decouples human browsing from agent automation. External agents communicate through a zero-trust WebSocket bridge (`BridgeServer`) and stdio MCP proxy (`scripts/antifan-omp-mcp.cjs`). By default, agents are pinned to dedicated offscreen `automationTarget` tabs; active user tabs are strictly guarded against accidental hijacking.\n2. **Deterministic Evidence & Verification Engine:** Replaces fuzzy LLM impressions with falsifiable mechanical truth. All DOM, layout, and visual verifications are anchored to monotonic `documentGeneration` and `mutationRevision` barriers. Visual comparison (`VisualCaptureSpace`) maps CSS coordinates to physical raster pixels with strict fail-closed mask budgets (maximum 70% masked area ratio).\n3. **Dual-Tier Reality Gate:**\n   - **Tier 1 (Chromium Engine):** Deeply customized Electron `WebContentsView` architecture featuring docked DevTools, ConPTY-backed `TerminalManager`, docked split desktop/mobile views, tracker isolation, and raw CDP protocol access.\n   - **Tier 2 (Real Physical Hardware):** Built-in native iOS device driver communicating directly over a zero-dependency local USB multiplexer (`UsbmuxClient` / `usbmuxd`) and WebDriverAgent (`WdaRestClient`) to drive real Mobile Safari sessions without cloud dependencies.\n4. **Ecommerce Theme QA & Site Clone Pipeline:** Specializes in Vietnam and global ecommerce platforms (Haravan DotLiquid, Shopify, Sapo). Features atomic workspace transactions with R0 rollback (`ThemeMutationSession`), comprehensive theme scanners (Liquid syntax, layout overflows, broken assets, HS compliance rules), and a standalone compiler (`packages/site-clone`) capable of generating either 100% offline self-contained HTML clones or native DotLiquid theme packages.\n5. **Local-First Knowledge & Audit Ledger:** Integrates `Super Core` (embedded SQLite via `node:sqlite`) for case-based reasoning, anti-pattern catalogs, and decision receipts, alongside append-only Write-Ahead Logging (`InvocationLedger`) for multi-session crash recovery.\n\n---\n\n## 2. Subsystems & Key Files\n\n### 2.1 Electron Main Subsystems (`src/main/`)\n- **`src/main/index.ts`** — Main Electron entrypoint orchestrating single-instance locks, Chromium acceleration flags, profile leases, `BrowserWindow` creation, and asynchronous control plane initialization.\n- **`src/main/browser/native-tab-host.ts`** — Core tab manager (7,600+ lines) orchestrating `WebContentsView` instances, split-view coordination, DevTools docking, URL sanitization, and terminal affinity.\n- **`src/main/browser/terminal-manager.ts`** — ConPTY/Node-PTY terminal multiplexer managing PTY processes, delivery journals (`SessionDeliveryJournal`), ack-sync, and terminal window persistence.\n- **`src/main/browser/tab-automation-host.ts`** — Synthetic input pipeline executing atomic action sequences (click, type, drag, hover, scroll) and isolated agent cursor overlays.\n- **`src/main/browser/tab-devtools-host.ts`** — Low-level CDP session coordinator handling device metrics emulation, touch events, and viewport/full-page raster captures.\n- **`src/main/browser/semantic-ref-registry.ts`** — In-memory registry generating and resolving monotonic semantic refs (`@e1`..`@eN`) stamped with target tab and document generations.\n- **`src/main/browser/semantic-ref-executor.ts`** — Isolated world script injector executing DOM queries and actions within `ISOLATED_AGENT_WORLD_ID` (999) to avoid colliding with target page scripts.\n- **`src/main/browser/tracker-isolation.ts`** — Ephemeral network barrier intercepting and blocking 3rd-party vendor tracking scripts (GTM, FB Pixel, Haravan analytics) during QA measurements.\n- **`src/main/browser/zero-network-interceptor.ts`** — Strict offline request barrier ensuring offline clones and test suites leak zero network packets.\n- **`src/main/browser/profile-ownership.ts`** — Exclusive filesystem profile lease manager with PID tracking, clean shutdown markers, and safe-start recovery.\n- **`src/main/browser/split-review-coordinator.ts`** — Dual-viewport coordinator synchronizing desktop and mobile panes, layout calculations, and split review persistence.\n- **`src/main/tools/capability-catalogue.ts`** — Central registry of 176 frozen capabilities enforcing execution policies, idempotency modes, and dispatch locks.\n- **`src/main/tools/browser-control-port.ts`** — Type-safe facade bridging high-level control-plane requests to concrete `NativeTabHost` operations.\n- **`src/main/tools/browser-capabilities.ts`** — Implements browser actions (tabs, navigation, styles, DOM dumps, screenshots, gestures) as registered capabilities.\n- **`src/main/tools/device-capabilities.ts`** — Registers 10 physical device capabilities (`device.list`, `device.status`, `device.tap`, etc.).\n- **`src/main/tools/core-capabilities.ts`** — Exposes Super Core queries, context packs, receipts, and experience graph tools to agents.\n- **`src/main/tools/file-capabilities.ts`** — Sandboxed, boundary-enforced file read/write capabilities (`file.read`, `file.write`).\n- **`src/main/tools/terminal-capabilities.ts`** — Terminal lifecycle, stream subscription, resize, and command execution capabilities.\n- **`src/main/tools/theme-transaction-capabilities.ts`** — Exposes atomic theme transaction methods (`theme.transaction.begin`, `write_files`, `commit`, `rollback`).\n- **`src/main/tools/artifact-store.ts`** — Content-addressed storage (CAS) managing deduplicated artifacts, SHA-256 digests, and retention sweep cleaning.\n- **`src/main/verification/verification-evaluator.ts`** — Deterministic claim adjudicator evaluating evidence bundles against proof obligations and document generation barriers.\n- **`src/main/verification/verification-contract.ts`** — Shared type system defining verification claims, proof profiles, freshness metrics, and verdicts.\n- **`src/main/verification/visual-capture.ts`** — Pure geometry engine handling affine CSS-to-raster transforms, clipRects, and fail-closed mask ledgers.\n- **`src/main/verification/visual-region.ts`** — Spatial layout inspector analyzing bounding boxes, z-indices, and section inventories.\n- **`src/main/verification/capture-settle.ts`** — Composed settle barrier evaluating network quiescence, font readiness, image decoding, and DOM quiet.\n- **`src/main/qa/theme-qa-workflow.ts`** — End-to-end theme verification pipeline coordinating scanners, differential regression analysis, and QA report generation.\n- **`src/main/qa/theme-qa-repair-coordinator.ts`** — Automated repair engine applying targeted theme code patches with R0 rollback guarantees.\n- **`src/main/qa/theme-mutation-session.ts`** — Transactional session manager handling CAS disk writes, workspace generations, and rollback states.\n- **`src/main/qa/scanners/platform-detector.ts`** — Heuristic platform detector distinguishing Haravan DotLiquid from Shopify OS 2.0 and Sapo.\n- **`src/main/qa/scanners/liquid-error-scanner.ts`** — DotLiquid AST scanner identifying unsupported filters (`reject`, `compact`, `where`) and broken tags.\n- **`src/main/qa/scanners/server-crash-scanner.ts`** — Server and rendering crash scanner inspecting console logs and network error bursts.\n- **`src/main/qa/scanners/broken-asset-scanner.ts`** — Scan engine identifying 404/500 assets, broken image dimensions, and missing font subsets.\n- **`src/main/qa/scanners/layout-overflow-engine.ts`** — Multi-viewport overflow engine detecting horizontal scrolling and layout clipping at 1440, 1024, and 390 px.\n- **`src/main/qa/rules/hs-gate-rules.ts`** — Hardened rules validating Sapo-to-Haravan platform migration invariants.\n- **`src/main/device/device-manager.ts`** — Manages physical iOS device connections, hardware UDIDs, and monotonic device attachment epochs.\n- **`src/main/device/ios-device-adapter.ts`** — Serialized iOS execution adapter coordinating WDA REST calls and artifact staging.\n- **`src/main/device/wda-rest-client.ts`** — Low-level REST client communicating with WebDriverAgent runner on port 8100.\n- **`src/main/device/usbmux-client.ts`** — Pure Node.js XML plist client connecting to the Windows Apple Mobile Device USB daemon.\n- **`src/main/device/usbmux-forwarder.ts`** — Port multiplexer tunneling loopback TCP connections directly to device usbmuxd ports.\n- **`src/main/device/device-readiness.ts`** — Evaluates physical device attachment, pairing trust, Developer Mode, and automation readiness milestones.\n- **`src/main/bridge/bridge-server.ts`** — WebSocket communication server relaying commands, tool invocations, and pairing tokens to external agents.\n- **`src/main/bridge/annotation-manager.ts`** — Stores and manages user visual feedback annotations and screenshot coordinates.\n- **`src/main/control-plane/control-plane-runtime.ts`** — Control plane engine managing project/workspace tenancy, leases, and capability transports.\n- **`src/main/session/invocation-ledger.ts`** — Durable WAL ledger writing JSON frames with SHA-256 checksums to guarantee zero orphaned operations.\n- **`src/main/session/receipt-store.ts`** — Durable disk store indexing verification receipts, proof profiles, and audit decisions.\n- **`src/main/session/event-store.ts`** — Append-only event store recording lifecycle and diagnostic occurrences.\n- **`src/main/session/issue-register.ts`** — Issue registry recording verified code and layout defects across sessions.\n- **`src/main/session/run-recovery.ts`** — Crash reconciliation service detecting interrupted operations upon startup and settling them gracefully.\n- **`src/main/workflow/workflow-engine.ts`** — Workflow engine executing multi-step automation pipelines defined in declarative JSON schemas.\n- **`src/main/server/preview-protocol-handler.ts`** — Custom Electron protocol handler (`antifan-preview://`) serving sandboxed workspace files.\n- **`src/main/server/safe-fs-resolver.ts`** — Path containment validator preventing directory traversal attacks when serving preview files.\n- **`src/main/security/security-policy.ts`** — Central security policy defining URL schemes, CSP policies, and web preferences.\n- **`src/main/native-messaging/local-ipc-server.ts`** — Windows Named Pipe IPC server communicating with companion browser extensions.\n- **`src/main/native-messaging/manifest-installer.ts`** — Windows registry helper registering Chrome/Edge/Brave Native Messaging hosts.\n- **`src/main/diagnostics/main-lifecycle-log.ts`** — Synchronous crash and lifecycle logger recording boot, heartbeat, and shutdown milestones.\n- **`src/main/config/storage-locations.ts`** — Cross-platform directory resolver for configurations, profile data, crash dumps, and caches.\n- **`src/main/project/workspace-capsule.ts`** — Isolated multi-project workspace manager associating directories with distinct preview hosts.\n\n### 2.2 Presentation & UI Layer (`src/renderer/`, `src/preload/`)\n- **`src/renderer/toolbar.ts`** — Comprehensive toolbar UI logic: multi-tab rendering, responsive presets, inspect mode, ruler, and QA triggers.\n- **`src/renderer/toolbar.html` / `toolbar.css`** — HTML markup and dark-theme VS Code styled layout for the browser chrome.\n- **`src/renderer/standalone.js` / `standalone.html`** — Standalone reader and review interface for exported clones and diff reports.\n- **`src/renderer/frame-backdrop.ts`** — Backdrop rendering surface for device frame emulation (e.g. mobile phone frame borders).\n- **`src/preload/toolbar-preload.ts`** — `contextBridge` script exposing typed IPC channels (`antifan:toolbar:*`) to the toolbar UI.\n- **`src/preload/tab-preload.ts`** — Tab script providing `navigator.webdriver = false` anti-detection and Haravan JSON view formatting.\n- **`src/preload/standalone-preload.ts`** — IPC preload for the standalone viewer window.\n- **`src/preload/frame-backdrop-preload.ts`** — IPC preload for the frame backdrop view.\n\n### 2.3 Shared Contracts & Protocols (`src/shared/`)\n- **`src/shared/control-plane-contracts.ts`** — Authoritative contract (1,029 lines) defining `CapabilityDefinition`, `RuntimeLease`, `FixRequestV2`, and error codes.\n- **`src/shared/contracts.ts`** — Data types for `AntiFanTab`, `ElementRect`, `SplitReviewState`, `AntiFanPickedElement`, and IPC channel names.\n- **`src/shared/theme-task-context.ts`** — Contracts linking OMP reasoning tasks to theme workspaces, element refs, and CAS receipts.\n- **`src/shared/device-control-contracts.ts`** — Physical device target definitions, binding contracts, tri-state gates, and error remediation steps.\n- **`src/shared/terminal-write-dispatcher.ts`** — Transport protocol for chunked, ack-verified PTY terminal writes.\n- **`src/shared/annotation-prompt.ts`** — Prompt synthesis templates for user visual annotations and element picks.\n\n### 2.4 Monorepo Packages (`packages/`)\n- **`packages/super-core/src/index.ts`** — Local SQLite-backed evidence store providing context packs, claims, anti-patterns, and decision receipts.\n- **`packages/super-core/src/schema.ts`** — DDL schemas, FTS5 full-text indexing, and versioned database migrations for Super Core.\n- **`packages/site-clone/src/models/clone-ir.ts`** — Intermediate representation definitions for cloned UI sections and ecommerce data models.\n- **`packages/site-clone/src/models/dom-tree-parser.ts`** — Tree walker parsing live DOM structures into clean, normalized component trees.\n- **`packages/site-clone/src/models/asset-localizer.ts`** — Pipeline downloading and rewriting remote assets to produce 100% offline local bundles.\n- **`packages/site-clone/src/generators/theme-compiler.ts`** — Atomic theme compiler generating production-ready Haravan flat-structure themes.\n- **`packages/site-clone/src/generators/independent-html-clone-generator.ts`** — Generator creating standalone offline HTML bundles with localized assets.\n- **`packages/site-clone/src/qa/clean-tab-probe.ts`** — Deterministic test probe asserting menu hovers, modal popups, and slider state transitions.\n- **`packages/site-clone/src/qa/mutation-qa-harness.ts`** — Mutation test harness certifying that clone bundles survive DOM perturbations.\n- **`packages/plugin-sdk/manifest-types.ts`** — Public declarative plugin SDK types and sandboxed hook interfaces.\n\n### 2.5 MCP & Agent Entrypoints (`scripts/`)\n- **`scripts/antifan-omp-mcp.cjs`** — Standalone stdio Model Context Protocol proxy exposing 176 tools with strict timeout ceiling dominance.\n- **`scripts/antifan-agent.cjs`** — Agent launcher finding live bridge instances, acquiring ephemeral leases, and wrapping target CLIs.\n- **`scripts/antifan-core.cjs`** — CLI tool providing command-line access to query and mutate the Super Core database.\n- **`scripts/check-mcp-budget-dominance.mjs`** — Compile-time safety check verifying that `DEFAULT_CLIENT_TIMEOUT_MS` dominates all server policies.\n- **`scripts/run-test-pipeline.mjs`** — Master test runner executing static gates, canaries, unit, integration, and e2e suites.\n- **`scripts/launch-guard.cjs`** — Bundle freshness validator comparing `.compiled/src/main/index.js` mtime against source files.\n\n### 2.6 Themes & Verification Specs (`themes/`, `specs/`)\n- **`specs/base-theme-contract.json`** — Machine-readable contract specifying Haravan DotLiquid limits, unsupported filters, and paths.\n- **`specs/qa-matrix.json`** — Baseline QA score matrix across 8 dimensions (visual, semantics, modularity, operability, compliance, assets, responsiveness, CWV).\n- **`themes/universal-haravan-base/`** — Standard baseline Haravan theme implementation adhering to the flat directory structure.\n- **`themes/roahtrip-haravan/`** — Modern OS 2.0 Haravan theme implementation featuring sections, JSON templates, and custom snippets.\n\n### 2.7 Operations, Audits & Bottlenecks\n- **`plans/bottlenecks.json`** — Machine-checkable defect ledger tracking 32+ architectural bottlenecks, closure evidence, and reproduction predicates.\n- **`docs/operations.md`** — Comprehensive operational manual covering prerequisites, device setup, tool mappings, and troubleshooting.\n\n---\n\n## 3. Cross-Boundary Data Flows & Contracts\n\n### 3.1 Agent-to-Browser Control Flow (Dual-Plane Isolation)\n```\n[Agent Process: OMP / Claude Code]\n        | (Stdio MCP JSON-RPC)\n        v\n[scripts/antifan-omp-mcp.cjs] (Stdio Server Proxy)\n        | (WebSocket JSON-RPC with Auth Bearer Token)\n        v\n[BridgeServer] (Port 20129 / 20130)\n        | Validate RuntimeLease & AttachmentRegistry\n        v\n[ControlPlaneRuntime]\n        | Enforce Capability Policy (Timeout, Risk, DuplicateMode)\n        v\n[BrowserControlPort]\n        | Acquire ViewportGate Lock (Mutual Exclusion)\n        v\n[NativeTabHost]\n        |-- (Target: `automationTarget`, Offscreen Agent Tab)\n        |-- Never hijacks active user tab unless explicitly targeted\n        |\n        v\n[TabWebContentsView / CDP / Isolated World 999]\n```\n1. **Invocation Entry:** An external agent invokes an MCP tool (e.g. `anti.browser.navigate`). The stdio proxy (`antifan-omp-mcp.cjs`) forwards the call over WebSocket to `BridgeServer`.\n2. **Authority Resolution:** `BridgeServer` validates the ephemeral `RuntimeLease` and retrieves the bound `automationTarget` tab ID. If no target was established, unbound tools fail closed with `TARGET_REQUIRED`.\n3. **Policy Freeze & Locking:** `CapabilityCatalogue` verifies that the capability is permitted, checks execution risk, and acquires the `ViewportGate` mutex for target-bound operations.\n4. **Execution in Isolation:** Actions involving JavaScript evaluation or DOM inspection are executed inside `ISOLATED_AGENT_WORLD_ID` (999), preventing interference with prototype chains or window globals on the target storefront.\n\n### 3.2 Tier-2 Physical Hardware Execution Flow\n```\n[Agent: device.tap({ x, y })]\n        v\n[CapabilityCatalogue: device-capabilities]\n        | Check `requiresDeviceTarget`, Match Live UDID & Epoch\n        v\n[IosDeviceAdapter]\n        | Acquire Per-Device Lock (Chain Leaf Execution)\n        v\n[WdaRestClient]\n        | REST HTTP Request (e.g. POST /session/:id/wda/touch/perform)\n        v\n[UsbmuxForwarder]\n        | TCP Tunnel over 127.0.0.1 -> usbmuxd\n        v\n[Physical iPhone: WebDriverAgent Runner -> Mobile Safari]\n        v\n[Evidence Receipt Staged to ArtifactStore]\n```\n- **Monotonic Epochs:** Physical connection state is tracked via `deviceEpoch`. Re-plugging a phone advances the epoch; any previously minted `DeviceTarget` from an earlier epoch is rejected immediately with `TARGET_STALE`.\n- **Serialization:** WebDriverAgent crashes if concurrent sessions are initiated. `IosDeviceAdapter` serializes operations per device at the leaf method level, ensuring atomic execution.\n\n### 3.3 Theme Mutation & Rollback Boundary (B-Lite v2 Loop)\n```\n[Fixer Subagent]\n        |\n        v\n`theme.transaction.begin`\n        | Creates immutable R0 disk snapshot in memory/disk\n        | Acquires exclusive workspace lock\n        v\n`theme.transaction.write_files` (CAS diffs)\n        | Enforces path containment inside `allowedFiles`\n        | Validates diff byte and file budgets\n        v\n[ThemeQaWorkflow / HaravanSyncBarrier]\n        | Runs platform detection, Liquid error scans, overflow engine\n        v\nDecision:\n  - PASS  -> `theme.transaction.commit` (R0 snapshot cleared)\n  - FAIL  -> `theme.transaction.rollback` (Workspace restored exactly to R0)\n  - DRIFT -> Fail-closed halt (No git reset --hard; surgical path restore)\n```\n- Strict separation of concerns: The verification engine owns evidence and verdicts; it **never** executes destructive git commands (`git checkout -- .`, `git reset --hard`). Workspace restoration is purely path-scoped byte restoration from real disk snapshots.\n\n### 3.4 Settle Barrier & Mechanical Evidence Integrity\nBefore any visual comparison or DOM snapshot is certified:\n1. **First-Party Network Quiescence:** Ensures in-flight network requests on the storefront origin drop to zero within a bounded timeout.\n2. **Font Readiness:** Awaits `document.fonts.ready` to avoid capturing layout shifts from web font swaps.\n3. **Image Decoding:** Probes in-viewport images; broken images (0x0 natural dimensions) trigger immediate fail-closed `RESOURCE_FAILURE`.\n4. **DOM Quiet:** Verifies that no childList DOM mutations occur within a double-rAF window.\n5. **Mask Ratio Ceiling:** During visual comparison (`anti.visual.compare`), all dynamic regions (chat widgets, live clocks) are masked. If total masked area exceeds 70% of the viewport, evaluation is rejected with `MASK_RATIO_POLICY_VIOLATION`.\n\n---\n\n## 4. Unresolved Technical Questions & Architectural Risks\n\nGrounded in `plans/bottlenecks.json`, test suite telemetry, and recent benchmark evidence, the following open risks and technical questions require vigilance:\n\n### 4.1 Open Bottlenecks (from `plans/bottlenecks.json`)\n1. **B19 (P1) — Carousel Starvation in Canary Settle Gate:**\n   - *Symptom:* `canary-settle.mjs` sums `addedNodes + removedNodes` and requires a 1,500 ms continuous quiet window inside a 9,000 ms budget. Fast periodic animations or carousels adding/removing DOM nodes every 1,000 ms can starve the quiet window, resulting in false `SETTLE_INCOMPLETE` failures.\n   - *Risk:* Live storefronts with autoplay sliders may be marked unadjudicable despite visual stability.\n2. **B20 (P2) — CDP 16,384 px Hardware Texture Limit:**\n   - *Symptom:* CDP `Page.captureScreenshot` is bound by Chromium's GPU texture limit (16,384 CSS px). Very long storefront pages (e.g. infinite-scroll collections >30,000 px) cannot be captured in a single raster frame and fall back to tiled composites on the main thread.\n   - *Risk:* Potential memory pressure on the Electron main process and compositing artifacts on extremely long catalog pages.\n3. **B21 (P3) — Workspace Root Hygiene:**\n   - *Symptom:* Accumulation of transient screenshots (`.png`), diagnostic reports, and scratch scripts directly in the project root.\n   - *Risk:* Visual clutter and risk of committing temporary artifacts into version control.\n4. **B23 & B30 (P1) — Campaign Normalization Timeout & Adjudicability:**\n   - *Symptom:* In large-scale 15-page campaigns, `anti.visual.compare` normalization exceeded its 15 s timeout on certain complex pages, resulting in `CAPTURE_INVALID` and an inconclusive executive verdict.\n   - *Risk:* Automated multi-page verification campaigns require robust timeout recovery and segment-level fallback to avoid batch invalidation.\n5. **B29 (P2) — MCP Catalogue Shadowing Rows:**\n   - *Symptom:* 23 routing rows in `scripts/antifan-omp-mcp.cjs` redirect capability names that the catalogue already registers natively, substituting custom proxy semantics for the server's registered defaults.\n   - *Risk:* Subtle discrepancies in default parameter handling between standalone MCP clients and direct control-plane callers.\n6. **B32 (P1) — Revision-Bound Campaign Verdicts:**\n   - *Symptom:* Published campaign artifacts (`_verdicts.json`) previously recorded `exit` and `finishedAt` as null, breaking strict provenance binding against HEAD git revisions.\n   - *Risk:* Risk of attributing stale campaign test runs to newer code revisions.\n\n### 4.2 Architectural Risks & Concurrency Boundaries\n1. **Electron Main Thread Saturation:**\n   - The Electron main process hosts `NativeTabHost`, DevTools CDP sessions, `TerminalManager` PTY dispatch, `BridgeServer` WebSockets, and `InvocationLedger` disk I/O. Intensive visual diffing or large JSON replays on populated profiles can cause brief event-loop delays (monitored by `startEventLoopDelayMonitor`).\n2. **Native Dependency & Platform Portability:**\n   - AntiFan utilizes `node-pty` with native ConPTY bindings on Windows, `node:sqlite` for Super Core, and usbmuxd plist protocol parsers for iOS. While cross-platform abstractions exist, Windows is the primary hardened production tier; running on Linux/macOS requires validating PTY spawn mechanics and Apple USB driver daemons.\n3. **WebDriverAgent Hardware Dependency:**\n   - Tier-2 iOS testing requires a physical device with a valid developer profile and active WDA runner. When disconnected, the system correctly reports `DEVICE_NOT_CONNECTED` without crashing, but live automated mobile hardware verification remains gated on physical bench setup.\n\n---\n\n## 5. Conclusion & Readiness Verdict\n\nAntiFan Browser Desktop exhibits exceptional engineering discipline:\n- **Zero Mock Policy:** Hardened invariants, strict schema validation, and real system probes across all test lanes.\n- **Fail-Closed Safety:** Ephemeral leases, transactional workspace locks, and immutable R0 snapshots ensure that automated agent actions cannot destroy developer workspaces.\n- **Verification Integrity:** Verification claims are strictly coupled to mechanical document generations, network quiescence, and raster diff limits.\n\nThe codebase is robust, highly structured, and fully ready for continued high-assurance autonomous agent operations.",
  "architecture": "```\n+-------------------------------------------------------------------------------------------------------------+\n|                                    EXTERNAL AGENTS & WORKFLOWS                                              |\n|            OMP Subagents / Claude Code / Antigravity IDE / Cursor / CLI (`antifan`, `antifan-agent`)        |\n+------------------------------------+------------------------------------------------------------------------+\n                                     | (Stdio MCP / HTTP / WebSocket Relay)\n                                     v\n+-------------------------------------------------------------------------------------------------------------+\n|                                       MCP & BRIDGE BOUNDARY                                                 |\n|  - `scripts/antifan-omp-mcp.cjs` (Stdio MCP Proxy: client timeout ceiling dominance, 176 capabilities)     |\n|  - `scripts/antifan-agent.cjs` (Agent CLI launcher: bridge candidate discovery, instance-pinned tokens)     |\n|  - `src/main/bridge/bridge-server.ts` (WebSocket Bridge: auth grants, pairing queue, agent sessions)       |\n|  - `src/main/native-messaging/local-ipc-server.ts` (Windows Named Pipe Companion Host for Chrome Ext)       |\n+------------------------------------+------------------------------------------------------------------------+\n                                     | Authenticated Dispatch (AttachmentRegistry / RuntimeLease)\n                                     v\n+-------------------------------------------------------------------------------------------------------------+\n|                                       CONTROL PLANE RUNTIME                                                 |\n|  - `src/main/control-plane/control-plane-runtime.ts` (Tenancy, lifecycle, lease verification, scheduler)   |\n|  - `src/main/tools/capability-catalogue.ts` (176 frozen policies, duplicateMode, risk classification)      |\n|  - `src/main/session/invocation-ledger.ts` (WAL frame checksums, crash recovery, replay protection)         |\n|  - `src/main/tools/artifact-store.ts` (CAS content-addressed storage, retention cleaner, byte bounds)       |\n|  - `packages/super-core/` (Local SQLite evidence engine, experience graph, claims, decision receipts)      |\n+-------------------+-----------------------------------+--------------------------------+--------------------+\n                    |                                   |                                |\n                    v                                   v                                v\n+------------------------------------+ +--------------------------------+ +----------------------------------+\n|      BROWSER & TABS (TIER 1)       | |     PHYSICAL DEVICE (TIER 2)   | |      THEME QA & TRANSACTIONS     |\n| - `NativeTabHost` (WebContentsView)| | - `DeviceManager` (Epoch track)| | - `ThemeMutationSession` (CAS)   |\n| - `TabAutomationHost` (Gestures)   | | - `UsbmuxClient` (USB plist)   | | - `ThemeQaWorkflow` (HS gates)   |\n| - `TabDevToolsHost` (Raw CDP)      | | - `WdaRestClient` (WDA HTTP)   | | - `PlatformDetector` (Haravan/S) |\n| - `SemanticRefRegistry` (@e1..@eN) | | - `IosDeviceAdapter` (Locked)  | | - `LayoutOverflowEngine` (CWV)   |\n| - `TrackerIsolation` (Net block)   | | - `DeviceReadiness` (Milestones| | - `HaravanSyncBarrier` (Settle)  |\n| - `TerminalManager` (Node-PTY, Con)| | -> Real Safari execution on iOS| | - `WorkspaceSnapshotRollback`    |\n+------------------------------------+ +--------------------------------+ +----------------------------------+\n                    |                                                                    |\n                    +-----------------------------------+--------------------------------+\n                                                        v\n+-------------------------------------------------------------------------------------------------------------+\n|                                        EVIDENCE & VERIFICATION LAYER                                        |\n|  - `VerificationEvaluator`: Mechanical DOM/Style/Visual proof checks (Freshness, DocumentGeneration barrier)|\n|  - `CaptureSettleGate`: Composed 4-layer settle (Network quiet, Fonts ready, Images decoded, DOM quiet rAF) |\n|  - `VisualCaptureSpace` & `MaskLedger`: Raster affine geometry, pixel-diffing (<70% mask ratio ceiling)     |\n|  - `packages/site-clone`: ComponentContractIR, Haravan Theme Compiler (DotLiquid), HTML Clone Generator     |\n+-------------------------------------------------------------------------------------------------------------+\n|                                          PRESENTATION LAYER                                                 |\n|  - `src/renderer/toolbar.ts` & `toolbar.html`: Multi-tab strip, device selector, inspector, QA dashboard   |\n|  - `src/preload/toolbar-preload.ts` & `tab-preload.ts`: contextBridge IPC, Haravan auto-JSON viewer, stealth|\n+-------------------------------------------------------------------------------------------------------------+\n```"
}

[You have received this identical output 3 times. Re-reading 'agent://Candidate1' will not change it — use a narrower selector (path:A-B), or proceed with the edit.]