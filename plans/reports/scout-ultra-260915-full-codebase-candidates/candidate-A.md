<!-- Ultra Verifier source material. Anonymized candidate A. -->
<!-- Controller-private mapping: A = Candidate3. Self-ratings stripped before judging. -->
<!-- NOTE: 7 paths in these raw reports failed controller validation and were dropped/corrected -->
<!-- in the materialized union (plans/reports/scout-union-260915-full-codebase-ultra.md §0.2). -->

{
  "summary": "AntiFan Browser Desktop v1.3.6 is an Electron 43 local control plane: a Chromium tab host (WebContentsView) plus a capability catalogue exposed to AI agents over three transports (in-process MCP server, standalone stdio MCP proxy → WebSocket bridge, Windows native-messaging pipe). A strict authority model (runtime lease → attachment → authority revision → browser/device target with epoch+generation fencing) gates every capability; evidence flows into a bounded ArtifactStore and verdicts are adjudicated by a deterministic VerificationEvaluator. Domain payloads: Theme QA (scanners + HS gate rules + transactional mutation with R0 snapshot/rollback + Haravan CLI sync barrier), a site-clone package (DOM→IR→Haravan theme compiler), a Super Core SQLite evidence/knowledge store, and a Tier-2 real-iOS device surface via usbmuxd/WebDriverAgent. Key open risks: two god-objects (native-tab-host.ts ~7.6k lines, browser-control-port.ts ~6.5k lines), 23 shadowing MCP routing rows (B29), and a clone-verification campaign that cannot yet emit a revision-bound adjudicable verdict (B23/B30/B32).",
  "files": [
    {
      "path": "package.json",
      "description": "v1.3.6 manifest: Electron 43 + node-pty + ws + MCP SDK + zod; compile chain runs emit-integrity check, tsc, MCP budget dominance gate, orphan-emit prune, static copy, extension build; test lanes split fast/canary/main/integration/e2e."
    },
    {
      "path": "src/main/index.ts",
      "description": "Composition root: privileged antifan-preview scheme, storage/profile/crash-report setup, single-instance lock, deferred (~1.5s post-paint) bridge+IPC startup, wires ControlPlaneRuntime, BrowserControlPort, DeviceManager, dual-plane automation-target binding."
    },
    {
      "path": "src/main/browser/native-tab-host.ts",
      "description": "~7.6k-line central tab host: WebContentsView lifecycle, split panes, device emulation, diagnostics, preview watcher, semantic refs, capsule partitions, agent-working state, attachment disposal."
    },
    {
      "path": "src/main/browser/tab-automation-host.ts",
      "description": "~2.5k-line agent action dispatcher: semantic-ref resolution, isolated-world-1004 execution, CDP trusted click/type/hover/drag, action sequences, file upload/drop, occlusion fail-closed gate."
    },
    {
      "path": "src/main/browser/tab-devtools-host.ts",
      "description": "~3.4k-line CDP/devtools sub-controller: evalJs, screenshots, isolated-world contexts, tracker-isolation apply/teardown, in-page tools (font finder, lens, ruler, picker)."
    },
    {
      "path": "src/main/browser/terminal-manager.ts",
      "description": "Canonical node-pty session manager (singleton): SessionDeliveryJournal with 2MiB/4096-chunk bound, generation+seq delta sync, process-tree kill, bridge endpoint identity."
    },
    {
      "path": "src/main/browser/split-review-coordinator.ts",
      "description": "Dual-pane desktop+mobile geometry engine (device bezels/frames), loop-guarded navigation mirroring, persisted-tab migration."
    },
    {
      "path": "src/main/browser/semantic-ref-registry.ts",
      "description": "Main-owned @eN ref allocation, snapshot lifecycle, exact-target descriptor resolution with epoch/generation/URL validation."
    },
    {
      "path": "src/main/browser/semantic-ref-executor.ts",
      "description": "Isolated-world (1004) script builder for fail-closed DOM actions: traversal-path resolution, fingerprint matching, document-mutation guards."
    },
    {
      "path": "src/main/browser/semantic-ref-types.ts",
      "description": "JSON-safe descriptor/envelope contracts, snapshot limits (150 descriptors, 512KB), collection nonce validation."
    },
    {
      "path": "src/main/browser/agent-browser.ts",
      "description": "Injected visual agent cursor/overlay/banner/highlight script (main world)."
    },
    {
      "path": "src/main/browser/scripts/injected-script-store.ts",
      "description": "Hot-reloadable CDP script registry; disk overrides via ANTIFAN_CDP_SCRIPTS_DIR / scripts/cdp."
    },
    {
      "path": "src/main/browser/scripts/advanced-inspection-scripts.ts",
      "description": "Isolated-world builders for computed styles, spatial region, and font inspection."
    },
    {
      "path": "src/main/browser/first-party-network-tracker.ts",
      "description": "Tracks in-flight first-party critical requests (document/stylesheet/script/font) feeding settle gates."
    },
    {
      "path": "src/main/browser/zero-network-interceptor.ts",
      "description": "Fetch.requestPaused zero-external-network transaction wrapper with deterministic drain and AggregateError preservation."
    },
    {
      "path": "src/main/browser/network-policy.ts",
      "description": "Strict local-vs-external URL classifier; blocks host-prefix bypasses (localhost.evil.com) and non-http(s) protocols."
    },
    {
      "path": "src/main/browser/tracker-isolation.ts",
      "description": "Third-party measurement blocklist + in-page Proxy stubs (fbq/gtag/dataLayer) so QA quiescence is reachable without breaking page JS."
    },
    {
      "path": "src/main/browser/target-operation-chain.ts",
      "description": "Bounded settle-wait helper so a stuck per-target operation degrades to refusal instead of wedging the tab."
    },
    {
      "path": "src/main/browser/workspace-resolver.ts",
      "description": "URL→workspace mapping over hardcoded E:\\Work roots (customizes/themes/apps) with exact + numeric-suffix host matching."
    },
    {
      "path": "src/main/browser/theme-source-mapper.ts",
      "description": "Maps rendered DOM hints to weighted Liquid source candidates (snippet/section/layout) with HIGH-confidence authority rule."
    },
    {
      "path": "src/main/browser/browser-session-partition.ts",
      "description": "Electron session partition derivation (persist:capsule-*/profile-*, ephemeral, native vs clean UA modes)."
    },
    {
      "path": "src/main/browser/profile-ownership.ts",
      "description": "Profile lock/recovery: antifan-profile.lock lease, clean-shutdown marker, safe-start recommendation, legacy profile migration."
    },
    {
      "path": "src/main/browser/chrome-profile-sync.ts",
      "description": "Chrome profile/bookmark import and cookie hydration mapping (host-only vs domain cookies, sameSite, Windows-epoch expiry)."
    },
    {
      "path": "src/main/browser/local-session-vault.ts",
      "description": "Offline cookie vault: JSON export/import, Cookie-Editor format, CDP hydration, trusted-sender gate."
    },
    {
      "path": "src/main/browser/local-credential-vault.ts",
      "description": "Password vault encrypted via safeStorage/DPAPI; origin derived from sender frame, consent gate, user-plane-only senders."
    },
    {
      "path": "src/main/browser/oauth-popup-manager.ts",
      "description": "OAuth popup interceptor: provider URL detection, child-window guards, session sharing, popup-chain prevention."
    },
    {
      "path": "src/main/browser/google-auth-identity.ts",
      "description": "Chrome UA + Client Hints spoofing for Google-auth and storefront compatibility."
    },
    {
      "path": "src/main/browser/capsule-partition-migration.ts",
      "description": "Pure, testable cookie migration persist:capsule-*→persist:profile-* with marker-gated completion."
    },
    {
      "path": "src/main/browser/history-manager.ts",
      "description": "Persistent browsing history (20k cap) + deferred Chrome profile history import + suggestions."
    },
    {
      "path": "src/main/browser/tab-bookmarks-manager.ts",
      "description": "Bookmark CRUD/persistence/suggestions."
    },
    {
      "path": "src/main/browser/tab-context-menu.ts",
      "description": "Page context menu: inspect tools, image detection, Haravan upload hooks."
    },
    {
      "path": "src/main/browser/app-menu.ts",
      "description": "Application menubar + self-update flow (source-vs-compiled mtime diff, recompile & relaunch)."
    },
    {
      "path": "src/main/browser/window-state.ts",
      "description": "Window bounds/maximize persistence with multi-monitor validation."
    },
    {
      "path": "src/main/browser/tab-diagnostics.ts",
      "description": "Per-tab bounded ring buffers for console + network-failure diagnostics with origin/first-party tagging."
    },
    {
      "path": "src/main/browser/device-presets.ts",
      "description": "Device emulation preset table (desktop/tablet/mobile, UA, DPR, corner radius)."
    },
    {
      "path": "src/main/browser/keyboard-normalizer.ts",
      "description": "Key/modifier normalization to Electron InputEvent descriptors."
    },
    {
      "path": "src/main/browser/element-picker.ts",
      "description": "In-page element picker + multi-select + comment modal script."
    },
    {
      "path": "src/main/browser/font-finder.ts",
      "description": "Typography inspector overlay script (Shadow-DOM aware)."
    },
    {
      "path": "src/main/browser/gpu-lens.ts",
      "description": "Canvas magnifier/color inspector overlay script."
    },
    {
      "path": "src/main/browser/ruler.ts",
      "description": "Pixel ruler + 8/64px grid overlay script."
    },
    {
      "path": "src/main/browser/haravan-uploader.ts",
      "description": "Image inspector/save-as/upload toolkit (PNG/JPG/WEBP/PDF/GIF)."
    },
    {
      "path": "src/main/browser/skill-scanner.ts",
      "description": "Scans ~/.gemini + workspace skill dirs and built-in agents for toolbar autocomplete."
    },
    {
      "path": "src/main/browser/annotation-dispatch.ts",
      "description": "Annotation→terminal prompt dispatch (sanitized single-line write to bound session)."
    },
    {
      "path": "src/main/browser/css-cascade-analyzer.ts",
      "description": "CDP getMatchedStylesForNode → active/overridden declarations, specificity, DoD grading."
    },
    {
      "path": "src/main/browser/tab-zoom-controller.ts",
      "description": "App/tab zoom factor clamping and stepping."
    },
    {
      "path": "src/main/control-plane/control-plane-runtime.ts",
      "description": "Owns all registries/stores (projects, workspaces, chats, events, receipts, ledger, artifacts, runs, files, capabilities, transport, terminal, theme transactions, workflow engine) + runtime lease + device port."
    },
    {
      "path": "src/main/tools/capability-catalogue.ts",
      "description": "Capability registry with frozen effect policies (risk, schedulerLane, duplicateMode, visibility, retention, cancellation semantics) and device/browser target authorization."
    },
    {
      "path": "src/main/tools/capability-transport.ts",
      "description": "Dispatch adapter: child intents, ExecutionControl (effect stages, cancellation acks, continuation validity), idempotent ledger claims."
    },
    {
      "path": "src/main/tools/browser-control-port.ts",
      "description": "~6.5k-line browser capability surface: visual capture/compare, mask ledger, normalization transactions, coherence guards, route identity, settle gates, zero-network."
    },
    {
      "path": "src/main/tools/artifact-store.ts",
      "description": "Evidence store: per-artifact/per-run byte budgets, evidence leases, hot cache, run index persistence, retention sweeper."
    },
    {
      "path": "src/main/tools/artifact-retention-cleaner.ts",
      "description": "Retention sweep honoring permanent report evidence and legacy entries."
    },
    {
      "path": "src/main/tools/workspace-file-port.ts",
      "description": "Workspace-confined file read/write port (boundary enforcement)."
    },
    {
      "path": "src/main/tools/file-capabilities.ts",
      "description": "file.read/file.write capability registrations over the workspace port."
    },
    {
      "path": "src/main/tools/terminal-capabilities.ts",
      "description": "Terminal capabilities (write/wait/sync) over the canonical TerminalManager."
    },
    {
      "path": "src/main/tools/device-capabilities.ts",
      "description": "device.* capability registrations bound to the live device binding."
    },
    {
      "path": "src/main/tools/core-capabilities.ts",
      "description": "core.* capability registrations over Super Core (lazy port creation)."
    },
    {
      "path": "src/main/tools/theme-transaction-capabilities.ts",
      "description": "theme transaction capability registrations (begin/writeCAS/commit/rollback)."
    },
    {
      "path": "src/main/tools/theme-evidence-envelope.ts",
      "description": "Standard evidence envelope wrapper for theme-domain results."
    },
    {
      "path": "src/main/tools/required-args.ts",
      "description": "Required-argument validation helper for capability inputs."
    },
    {
      "path": "src/main/tools/adapters/tree-walker-sanitizer.ts",
      "description": "DOM tree-walker sanitizer script adapter."
    },
    {
      "path": "src/main/session/event-store.ts",
      "description": "Append-only JSONL event log with header lineage check, replay, tail repair, checkpoint."
    },
    {
      "path": "src/main/session/receipt-store.ts",
      "description": "Authoritative receipt persistence with commandId-binding dedupe and reconcile."
    },
    {
      "path": "src/main/session/invocation-ledger.ts",
      "description": "Partitioned idempotent invocation frames with sha256 checksums, quarantine/poison handling, shutdown settlement."
    },
    {
      "path": "src/main/session/run-recovery.ts",
      "description": "Run recovery helpers for interrupted executions."
    },
    {
      "path": "src/main/session/issue-register.ts",
      "description": "Issue register for tracking semantic/QA findings."
    },
    {
      "path": "src/main/run/run-service.ts",
      "description": "Run/attempt lifecycle, CLI+workflow session creation, attachment wiring, pid tracking."
    },
    {
      "path": "src/main/run/attachment-registry.ts",
      "description": "Attachment records, authority-revision CAS, invocation nonces, JSONL persistence, dispose listener for owned agent tabs."
    },
    {
      "path": "src/main/agent/execution-backend.ts",
      "description": "ExecutionBackend interface: startRun/cancel/resume yielding typed RunEvent stream."
    },
    {
      "path": "src/main/agent/codex-execution-backend.ts",
      "description": "Spawns approved `codex exec --json`, injects attachment env (ANTIFAN_MCP_BOOTSTRAP), maps JSONL events."
    },
    {
      "path": "src/main/agent/deepseek-harness-adapter.ts",
      "description": "DeepSeek harness backend adapter."
    },
    {
      "path": "src/main/agent/session-resume-controller.ts",
      "description": "Agent session resume/rebind control."
    },
    {
      "path": "src/main/mcp/mcp-server.ts",
      "description": "In-memory MCP server: static antifan_* tools, bound attachment session from env, transport-backed dispatch."
    },
    {
      "path": "src/main/mcp/result-envelope.ts",
      "description": "MCP result envelope shaping."
    },
    {
      "path": "src/main/bridge/bridge-server.ts",
      "description": "~3.1k-line WS+HTTP bridge on 127.0.0.1:20129/20130: pairing records, extension/mobile grants, DACL hardening, credential redaction, mobile remote app."
    },
    {
      "path": "src/main/bridge/annotation-manager.ts",
      "description": "Annotation storage/routing for picked elements."
    },
    {
      "path": "src/main/bridge/mobile-remote-html.ts",
      "description": "Mobile remote companion web app HTML."
    },
    {
      "path": "src/main/bridge/qr-generator.ts",
      "description": "QR SVG generation for mobile pairing."
    },
    {
      "path": "src/main/native-messaging/local-ipc-server.ts",
      "description": "Windows named-pipe server: launch-nonce handshake → bridge token/port/partition grant."
    },
    {
      "path": "src/main/native-messaging/framing.ts",
      "description": "Native-messaging length-prefixed framing codec."
    },
    {
      "path": "src/main/native-messaging/manifest-installer.ts",
      "description": "Chrome/Edge/Brave native messaging manifest registration."
    },
    {
      "path": "src/main/native-messaging/host-runner.ts",
      "description": "Native host runner entry."
    },
    {
      "path": "src/main/native-messaging/windows-acl.ts",
      "description": "DACL hardening for runtime auth files/pipe (icacls/powershell)."
    },
    {
      "path": "src/main/native-messaging/local-ipc-client.ts",
      "description": "Client side of the local IPC handshake."
    },
    {
      "path": "src/main/verification/verification-evaluator.ts",
      "description": "Claim+evidence→verdict adjudicator: freshness barriers (documentGeneration/mutationRevision), completeness, metric matching; INCONCLUSIVE/RESAMPLE on stale evidence."
    },
    {
      "path": "src/main/verification/visual-capture.ts",
      "description": "Capture envelopes, mask ledger, normalization transactions, two-source coherence guard, route identity checks, render-surface probing."
    },
    {
      "path": "src/main/verification/capture-settle.ts",
      "description": "Pre-capture quiescence gate (DOM/network/settle predicates)."
    },
    {
      "path": "src/main/verification/scroll-prewarm.ts",
      "description": "Bounded staircase scroll pre-warm for lazy content before full-page capture."
    },
    {
      "path": "src/main/verification/baseline-authority.ts",
      "description": "Visual baseline reference authority + PNG dimension reading."
    },
    {
      "path": "src/main/verification/visual-region.ts",
      "description": "Visual region normalization + structural metrics + query script builder."
    },
    {
      "path": "src/main/verification/interaction-delta.ts",
      "description": "Sparse interaction delta computation."
    },
    {
      "path": "src/main/verification/interaction-contract.ts",
      "description": "Action boundary / raw behavior scope / observation integrity contracts."
    },
    {
      "path": "src/main/verification/mutation-attribution.ts",
      "description": "Attributes DOM mutations to interactions."
    },
    {
      "path": "src/main/verification/modular-gates.ts",
      "description": "Composable verification gate modules."
    },
    {
      "path": "src/main/verification/circuit-breaker.ts",
      "description": "Verification batch lifecycle / circuit breaker (stalemate detection)."
    },
    {
      "path": "src/main/verification/stability-policy.ts",
      "description": "Stability policy for evidence sampling."
    },
    {
      "path": "src/main/verification/proof-templates.ts",
      "description": "Proof template registry for claim obligations."
    },
    {
      "path": "src/main/verification/theme-proof-helpers.ts",
      "description": "Theme-domain proof helpers."
    },
    {
      "path": "src/main/verification/verification-contract.ts",
      "description": "Verification claim/bundle/verdict type contracts."
    },
    {
      "path": "src/main/qa/theme-qa-workflow.ts",
      "description": "~1.4k-line Theme QA orchestrator: platform detect → liquid scan → overflow → broken assets → HS rules → diagnostics → differential attribution → QA matrix report."
    },
    {
      "path": "src/main/qa/scanners/platform-detector.ts",
      "description": "Ecommerce platform detection (Haravan/Sapo/Shopify/custom)."
    },
    {
      "path": "src/main/qa/scanners/liquid-error-scanner.ts",
      "description": "Liquid/DotLiquid error surface scanner."
    },
    {
      "path": "src/main/qa/scanners/server-crash-scanner.ts",
      "description": "Server crash/5xx scanner."
    },
    {
      "path": "src/main/qa/scanners/broken-asset-scanner.ts",
      "description": "Broken asset/link scanner."
    },
    {
      "path": "src/main/qa/scanners/layout-overflow-engine.ts",
      "description": "Horizontal overflow measurement across viewports."
    },
    {
      "path": "src/main/qa/rules/hs-gate-rules.ts",
      "description": "Haravan→Sapo (HS) conversion gate rules."
    },
    {
      "path": "src/main/qa/theme-transaction-registry.ts",
      "description": "Runtime-owned transaction authority: exclusive workspace locks, CAS writes, session map keyed by canonical root."
    },
    {
      "path": "src/main/qa/theme-mutation-session.ts",
      "description": "Mutation session primitive: R0 snapshot, CAS writes, sync barrier, lineage attestation, commit/rollback; fails closed."
    },
    {
      "path": "src/main/qa/workspace-snapshot-rollback.ts",
      "description": "Workspace snapshot manifests (sha256 per file), atomic writes with lock retry, path-scoped rollback; symlink/reparse fail-closed."
    },
    {
      "path": "src/main/qa/haravan-sync-barrier.ts",
      "description": "Deterministic remote-sync attestation: waits for Haravan CLI watcher output after baseline seq in same sessionGeneration."
    },
    {
      "path": "src/main/qa/theme-qa-repair-coordinator.ts",
      "description": "Repair sessions: R0 snapshot → R1 baseline → external fix → re-verify → commit or rollback (10min TTL)."
    },
    {
      "path": "src/main/qa/async-qa-job-queue.ts",
      "description": "Async QA job queue."
    },
    {
      "path": "src/main/qa/diagnostics-filter.ts",
      "description": "Diagnostic classification, first-party origin computation, correlatable asset-failure extraction."
    },
    {
      "path": "src/main/device/device-manager.ts",
      "description": "iOS device registry: usbmux enumeration, deviceEpoch (physical attach) vs sessionGeneration (WDA session) split, fail-closed binding."
    },
    {
      "path": "src/main/device/usbmux-client.ts",
      "description": "usbmuxd enumeration client."
    },
    {
      "path": "src/main/device/usbmux-forwarder.ts",
      "description": "USB port forwarder to device services."
    },
    {
      "path": "src/main/device/wda-rest-client.ts",
      "description": "WebDriverAgent REST client (sessions, tap/swipe/type/screenshot)."
    },
    {
      "path": "src/main/device/ios-session-manager.ts",
      "description": "WDA session lifecycle manager."
    },
    {
      "path": "src/main/device/ios-device-adapter.ts",
      "description": "DeviceControlPort adapter staging device evidence into the artifact store."
    },
    {
      "path": "src/main/device/device-readiness.ts",
      "description": "Device readiness gates (attach/trust/dev-mode/UI-automation/WDA)."
    },
    {
      "path": "src/main/device/device-control-port.ts",
      "description": "Device port/registry interfaces."
    },
    {
      "path": "src/main/workflow/workflow-engine.ts",
      "description": "Schema-validated multi-step workflow executor: retries, abort, per-step events, target assertion."
    },
    {
      "path": "src/main/workflow/workflow-schema.ts",
      "description": "Zod workflow definition schema + step/result types."
    },
    {
      "path": "src/main/workflow/workflow-registry.ts",
      "description": "Workflow definition registry."
    },
    {
      "path": "src/main/workflow/workflow-capabilities.ts",
      "description": "workflow.* capability registrations."
    },
    {
      "path": "src/main/server/preview-protocol-handler.ts",
      "description": "antifan-preview:// privileged scheme handler serving workspace files."
    },
    {
      "path": "src/main/server/preview-url-codec.ts",
      "description": "Preview URL build/parse codec."
    },
    {
      "path": "src/main/server/preview-watcher-pool.ts",
      "description": "fs watcher pool for live preview reload."
    },
    {
      "path": "src/main/server/safe-fs-resolver.ts",
      "description": "Safe filesystem path resolution for preview serving."
    },
    {
      "path": "src/main/security/security-policy.ts",
      "description": "WebPreferences hardening, navigation allowlist, URL sanitization."
    },
    {
      "path": "src/main/security/windows-acl.ts",
      "description": "Windows DACL enforcement helpers."
    },
    {
      "path": "src/main/config/storage-locations.ts",
      "description": "Canonical config/data/cache/runtime/profile directory layout."
    },
    {
      "path": "src/main/project/workspace-capsule.ts",
      "description": "Workspace capsule (project container) manager + active capsule persistence."
    },
    {
      "path": "src/main/project/project-registry.ts",
      "description": "Project registry."
    },
    {
      "path": "src/main/project/workspace-registry.ts",
      "description": "Workspace registry."
    },
    {
      "path": "src/main/chat/chat-store.ts",
      "description": "Chat record store."
    },
    {
      "path": "src/main/diagnostics/main-lifecycle-log.ts",
      "description": "Durable lifecycle journal (sync appends) + exit interceptor/recorder for death-window forensics."
    },
    {
      "path": "src/main/benchmark/telemetry.ts",
      "description": "Benchmark-gated telemetry (startup milestones, event-loop delay, process metrics)."
    },
    {
      "path": "src/main/telemetry/fallback-recorder.ts",
      "description": "Sanitized fallback telemetry when agents fall back to Playwright."
    },
    {
      "path": "src/shared/control-plane-contracts.ts",
      "description": "~1k-line contract core: entity IDs, leases, targets, error codes, B-Lite v2 fix-loop contract (FixRequestV2/FixResultV2, diff budgets, SCOPE_DISCOVERY, ownership split)."
    },
    {
      "path": "src/shared/contracts.ts",
      "description": "IPC channel names + tab/terminal/annotation payload types shared with renderer."
    },
    {
      "path": "src/shared/theme-task-context.ts",
      "description": "Theme workspace context, lineage, CAS write, transaction receipt types + validators."
    },
    {
      "path": "src/shared/device-control-contracts.ts",
      "description": "Device binding/target types + remediation hints."
    },
    {
      "path": "src/shared/annotation-prompt.ts",
      "description": "Annotation prompt construction."
    },
    {
      "path": "src/shared/terminal-write-dispatcher.ts",
      "description": "Shared terminal write dispatch contract."
    },
    {
      "path": "src/renderer/toolbar.ts",
      "description": "Toolbar UI logic (tabs, nav, presets, QA hub, phone status)."
    },
    {
      "path": "src/renderer/standalone.js",
      "description": "Standalone viewer surface."
    },
    {
      "path": "src/renderer/frame-backdrop.ts",
      "description": "Device frame backdrop renderer for split review."
    },
    {
      "path": "src/renderer/terminal-write-dispatcher.js",
      "description": "Renderer-side terminal write dispatcher."
    },
    {
      "path": "src/preload/toolbar-preload.ts",
      "description": "contextBridge API exposing ~50 toolbar IPC channels."
    },
    {
      "path": "src/preload/tab-preload.ts",
      "description": "Tab WebContents preload."
    },
    {
      "path": "src/preload/standalone-preload.ts",
      "description": "Standalone surface preload."
    },
    {
      "path": "src/preload/frame-backdrop-preload.ts",
      "description": "Frame backdrop preload."
    },
    {
      "path": "scripts/antifan-omp-mcp.cjs",
      "description": "~1.6k-line standalone stdio MCP proxy: static tool table (anti.*/device.*/theme.*/core.*/file.*), WS bridge to desktop, single 240s client ceiling."
    },
    {
      "path": "scripts/antifan-agent.cjs",
      "description": "CLI agent launcher injecting ANTIFAN_MCP_PORT/ANTIFAN_MCP_BOOTSTRAP into child env."
    },
    {
      "path": "scripts/antifan-core.cjs",
      "description": "antifan-core CLI entrypoint."
    },
    {
      "path": "scripts/run-test-pipeline.mjs",
      "description": "Ordered test lanes: compile → canary → fast → main → integration → e2e."
    },
    {
      "path": "scripts/check-bottlenecks.mjs",
      "description": "Machine-checkable bottleneck ledger gate (closed/open/refuted predicates)."
    },
    {
      "path": "scripts/check-mcp-budget-dominance.mjs",
      "description": "Compile-time gate: proxy timeout ceiling dominates largest policy budget; reports shadowing routing rows."
    },
    {
      "path": "scripts/check-emit-integrity.mjs",
      "description": "Discards stale tsbuildinfo when expected emit is missing (incremental self-heal)."
    },
    {
      "path": "scripts/launch-guard.cjs",
      "description": "Stale-bundle guard: compares bundle mtime vs newest src input; builds (dev) or refuses (packaged)."
    },
    {
      "path": "scripts/run-electron.cjs",
      "description": "Electron launcher with compile-if-missing and process identity."
    },
    {
      "path": "scripts/dev.mjs",
      "description": "Dev watcher: tsc watch + scripts/cdp watch + dev pid lock."
    },
    {
      "path": "packages/super-core/src/index.ts",
      "description": "node:sqlite local-first evidence store: claims/evidence/units/skills/conflicts/cases/candidates/adjudications/releases/receipts/packs + v4 experience graph, anti-patterns, workarounds, fix patterns, principles; no auto-promotion."
    },
    {
      "path": "packages/super-core/src/schema.ts",
      "description": "Core DDL + migrations + schema version."
    },
    {
      "path": "packages/site-clone/src/index.ts",
      "description": "Site-clone barrel: models (DOM parser, blueprint extractor, asset harvester/localizer, responsive scanner, state synthesizer, ecommerce modeler, clone IR, page manifest), generators (theme compiler, liquid binding, haravan-*, independent HTML clone), QA harnesses, Haravan platform adapter."
    },
    {
      "path": "packages/site-clone/src/generators/theme-compiler.ts",
      "description": "Clone IR → Haravan theme compiler."
    },
    {
      "path": "packages/site-clone/src/generators/liquid-binding-engine.ts",
      "description": "Liquid binding engine mapping IR to Liquid objects."
    },
    {
      "path": "packages/site-clone/src/generators/independent-html-clone-generator.ts",
      "description": "Standalone HTML clone generator (platform-free output)."
    },
    {
      "path": "packages/site-clone/src/platform/haravan/haravan-adapter.ts",
      "description": "Haravan platform adapter (routes, entities, store discovery)."
    },
    {
      "path": "packages/site-clone/src/qa/mutation-qa-harness.ts",
      "description": "Mutation QA harness for clone verification."
    },
    {
      "path": "packages/site-clone/src/qa/haravan-campaign-matrix.ts",
      "description": "Campaign matrix driving multi-page/multi-viewport clone verification."
    },
    {
      "path": "packages/site-clone/src/qa/dod-validator.ts",
      "description": "Definition-of-Done validator."
    },
    {
      "path": "packages/site-clone/src/qa/final-provenance-ledger.ts",
      "description": "Final provenance ledger for clone evidence."
    },
    {
      "path": "packages/plugin-sdk/manifest-types.ts",
      "description": "Plugin SDK v1 manifest types: permissions, hooks, integrity hashes, sandbox rules."
    },
    {
      "path": "specs/base-theme-contract.json",
      "description": "Authoritative Haravan contract: DotLiquid dialect, unsupported filters/constructs (no sections/*.liquid, no templates/*.json), required structure, routes, semantic landmarks, API surfaces, preview addressing."
    },
    {
      "path": "specs/qa-matrix.json",
      "description": "8-dimension QA scoring contract (visualFidelity…performanceCWV) + desktop/tablet/mobile viewport verdicts."
    },
    {
      "path": "themes/universal-haravan-base",
      "description": "Reference flat-directory Haravan theme: layout/theme.liquid, 19 templates, 16 snippets, settings.html+schema+data, theme.css/js."
    },
    {
      "path": "themes/roahtrip-haravan",
      "description": "OS2-style theme with sections/, locales/, index.json — conflicts with base contract's unsupported-construct list (see risks)."
    },
    {
      "path": "plans/bottlenecks.json",
      "description": "Machine-checkable defect ledger: 6 open rows (B19/B20/B21/B23/B29/B30/B32), refuted rows retained as anti-regression records."
    },
    {
      "path": "test/main",
      "description": "~150 main-process test files covering every subsystem (terminal, tabs, MCP, QA, security, native messaging, partitions)."
    },
    {
      "path": "test/unit",
      "description": "~60 unit tests incl. canary *.test.mjs lane driven by tracked fixtures."
    },
    {
      "path": "test/integration",
      "description": "5 integration tests (theme-qa vertical slice, semantic-ref, multi-tab MCP, cancellation, multi-project concurrency)."
    },
    {
      "path": "test/e2e",
      "description": "14 e2e/smoke harnesses (terminal transport, golden-live theme, soak, MCP industrial, trusted CDP)."
    },
    {
      "path": "test/benchmark",
      "description": "Benchmark contract tests (modular gates, anti-hallucination)."
    }
  ],
  "architecture": "Layered control plane: (1) Composition root src/main/index.ts boots StorageLocations → persistent profile+lease → BrowserWindow → NativeTabHost → ControlPlaneRuntime → BrowserControlPort → DeviceManager → deferred BridgeServer+LocalIpcServer. (2) Authority chain: RuntimeLease → AttachmentRegistry (attachment + authorityRevision CAS) → CapabilityCatalogue (frozen effect policies) → CapabilityTransportAdapter (idempotent dispatch via InvocationLedger) → port (BrowserControlPort | DeviceControlPort | WorkspaceFilePort | TerminalManager | Core). (3) Target fencing: every browser capability validates tabId + browserEpoch + documentGeneration (+ mutationRevision for evidence); device capabilities validate deviceEpoch + sessionGeneration against the live binding — caller-supplied targets are never trusted. (4) Dual-plane isolation: agent sessions bind to dedicated offscreen automation tabs, never the user's foreground tab; attachment disposal closes only owned offscreen tabs. (5) Evidence plane: captures/reports stage into ArtifactStore under per-run leases and byte budgets; VerificationEvaluator adjudicates claims against freshness barriers; receipts persist in ReceiptStore; events in append-only EventStore. (6) Agent ingress: three transports — in-process MCP (mcp-server.ts, antifan_* tools), standalone stdio proxy (antifan-omp-mcp.cjs, anti.*/device.*/core.* tools → WS bridge), and Windows native-messaging pipe for the companion extension; execution backends (codex) spawn external agents with attachment env injected. (7) Theme domain: ThemeQaWorkflow (scanners + HS rules) reads the live tab; ThemeMutationSession provides R0-snapshot CAS-write transactions with HaravanSyncBarrier attesting CLI upload before tab reload; ThemeQaRepairCoordinator runs snapshot→fix→verify→rollback loops. (8) Packages: super-core (SQLite knowledge/evidence store behind core.* capabilities), site-clone (DOM→IR→Haravan compiler + campaign QA), plugin-sdk (declarative plugin manifest types).",
  "report": "# Ultra Verifier Scout Report — AntiFan Browser Desktop v1.3.6\n\n## 1. Executive Architecture Summary\n\nAntiFan Browser Desktop is a single-process-composed Electron control plane that turns a Chromium tab host into a deterministic, receipt-backed automation surface for external AI agents. The design center is an **authority-and-evidence model**, not a browser: every mutation or observation flows through a frozen capability policy, is bound to a revisioned attachment, is fenced by target epochs/generations, and — when it produces evidence — stages artifacts under a leased, byte-budgeted store whose outputs feed a deterministic verdict evaluator.\n\nFive planes coexist deliberately:\n\n- **User plane**: visible tabs, toolbar renderer, DevTools utilities, session/credential vaults, Chrome profile sync.\n- **Agent plane**: offscreen automation tabs owned by attachments; the bridge refuses to bind an agent to the user's foreground tab (fail-closed `browserTarget: undefined`).\n- **Control plane**: ControlPlaneRuntime owns all stores and the CapabilityCatalogue; policies are validated and frozen at registration (risk, schedulerLane, duplicateMode, recordedVisibility, retentionPolicy, cancellation semantics).\n- **Evidence plane**: ArtifactStore (leases, per-run budgets, retention sweep), ReceiptStore, InvocationLedger (partitioned, checksummed, idempotent), EventStore (append-only JSONL with tail repair), VerificationEvaluator (freshness barriers + completeness + metric matching).\n- **Device plane (Tier-2)**: real iOS hardware via usbmuxd + WebDriverAgent, with deviceEpoch (physical attach) strictly separated from sessionGeneration (WDA session) so a re-plug can never validate a stale target.\n\nStartup is latency-staged: window paints first; control-plane ledger replay and bridge/IPC listeners are deferred (~0–1.5s) because both pay synchronous main-thread costs (JSON.parse+sha256 replay; icacls DACL spawns).\n\n## 2. Subsystems & Key Files\n\nSee `files` for the full annotated inventory (~140 entries). Subsystem clusters:\n\n- **Bootstrap/config**: `src/main/index.ts`, `config/storage-locations.ts`, `browser/profile-ownership.ts`, `diagnostics/main-lifecycle-log.ts`, `benchmark/telemetry.ts`.\n- **Tab host & automation**: `browser/native-tab-host.ts` (7.6k lines — god-object), `browser/tab-automation-host.ts` (2.5k), `browser/tab-devtools-host.ts` (3.4k), `browser/split-review-coordinator.ts`, `browser/semantic-ref-{registry,types,executor}.ts`, `browser/agent-browser.ts`, `browser/scripts/*`.\n- **Determinism primitives**: `browser/zero-network-interceptor.ts`, `browser/network-policy.ts`, `browser/tracker-isolation.ts`, `browser/first-party-network-tracker.ts`, `browser/target-operation-chain.ts`, `verification/capture-settle.ts`, `verification/scroll-prewarm.ts`.\n- **Control plane**: `control-plane/control-plane-runtime.ts`, `tools/capability-catalogue.ts`, `tools/capability-transport.ts`, `tools/browser-control-port.ts` (6.5k lines — second god-object), `tools/artifact-store.ts`, `tools/*-capabilities.ts`, `session/{event-store,receipt-store,invocation-ledger}.ts`, `run/{run-service,attachment-registry}.ts`.\n- **Agent ingress**: `mcp/mcp-server.ts` (in-process, `antifan_*` namespace), `scripts/antifan-omp-mcp.cjs` (stdio proxy, `anti.*`/`device.*`/`core.*`/`theme.*`/`file.*` namespace → WS bridge), `bridge/bridge-server.ts` (pairing, grants, DACL, mobile remote), `native-messaging/*` (Windows pipe handshake → bridge token), `agent/{execution-backend,codex-execution-backend}.ts`.\n- **Theme QA & mutation**: `qa/theme-qa-workflow.ts`, `qa/scanners/*`, `qa/rules/hs-gate-rules.ts`, `qa/{theme-transaction-registry,theme-mutation-session,workspace-snapshot-rollback,haravan-sync-barrier,theme-qa-repair-coordinator}.ts`.\n- **Verification**: `verification/{verification-evaluator,visual-capture,baseline-authority,visual-region,interaction-delta,mutation-attribution,circuit-breaker,modular-gates}.ts`.\n- **Device**: `device/{device-manager,usbmux-client,usbmux-forwarder,wda-rest-client,ios-session-manager,ios-device-adapter,device-readiness}.ts`.\n- **Workflow**: `workflow/{workflow-engine,workflow-schema,workflow-registry,workflow-capabilities}.ts`.\n- **Renderer/preload**: `renderer/{toolbar,standalone,frame-backdrop}.*`, `preload/*-preload.ts` (~50-channel toolbar bridge).\n- **Packages**: `packages/super-core` (SQLite evidence/knowledge store, no auto-promotion), `packages/site-clone` (DOM→IR→Haravan compiler + campaign QA), `packages/plugin-sdk` (manifest types only — no runtime found in-tree).\n- **Contracts**: `shared/control-plane-contracts.ts` (incl. B-Lite v2 fix-loop ownership split), `shared/theme-task-context.ts`, `shared/device-control-contracts.ts`, `shared/contracts.ts`.\n- **Specs/themes**: `specs/base-theme-contract.json` (authoritative Haravan platform contract), `specs/qa-matrix.json`, `themes/universal-haravan-base`, `themes/roahtrip-haravan`.\n- **Gates**: `scripts/{run-test-pipeline,check-bottlenecks,check-mcp-budget-dominance,check-emit-integrity,launch-guard,check-plans}.mjs|cjs`, `plans/bottlenecks.json`.\n\n## 3. Cross-Boundary Data Flows & Contracts\n\n**Agent invocation flow (stdio MCP path):** agent process → `antifan-omp-mcp.cjs` (static tool table, JSON-schema args) → WS to `BridgeServer` (127.0.0.1:20129/20130) with attachment secret → `CapabilityTransportAdapter` → `InvocationLedger` idempotent claim → `CapabilityCatalogue` policy+target authorization → port execution → receipt + artifacts → envelope back. The proxy owns a single 240s client ceiling; `check-mcp-budget-dominance.mjs` fails compile if the largest policy timeout outgrows it.\n\n**Extension/native path:** Chrome companion → native-messaging manifest → `host-runner` → `LocalIpcServer` named pipe → launch-nonce HANDSHAKE → bridge token + port + active partition → WS bridge with `ExtensionSessionGrant` (domain-allowlisted cookie import only).\n\n**External agent spawn path:** `RunService.createCliSession` → `AttachmentRegistry.issue` (secret, authorityRevision) → `CodexExecutionBackend` spawns approved executable with `ANTIFAN_MCP_BOOTSTRAP` env → child connects back through the stdio proxy → attachment-bound invocations.\n\n**Target fencing:** `assertExactBrowserTarget` compares tabId+browserEpoch+documentGeneration; effectful ops throw TARGET_STALE on drift, passive reads may auto-sync; failover only via host-owned `resolveFailoverTabId`. Semantic refs (`@eN`) additionally carry nonce+documentUrl and are resolved in isolated world 1004 with traversal-path + fingerprint verification; REF_DOCUMENT_MUTATED refuses post-navigation execution.\n\n**Theme mutation flow:** `theme.qa_repair.begin`/transaction begin → `createWorkspaceSnapshotManifest` (sha256 per file, symlink fail-closed) → CAS `file.write` via `WorkspaceFilePort` → `HaravanSyncBarrier.awaitSync` waits for CLI watcher ack after baseline terminal seq (same sessionGeneration) → tab reload → `documentGeneration` advance → re-verify → commit or `rollbackWorkspaceToManifest`. Repo-wide git destruction is contractually forbidden; rollback is path-scoped byte restore.\n\n**Verification flow:** claim recorded (UNVERIFIED + proofObligations) → evidence bundle captured (settle gate: DOM quiet + first-party network idle + scroll prewarm; zero-network or tracker-isolation windows optional) → `VerificationEvaluator` checks freshness (generation/revision barriers) then completeness/metrics → verdict VERIFIED/PARTIAL/REJECTED/INCONCLUSIVE persisted as receipt. High-confidence model claims cannot override missing mechanical evidence.\n\n**Clone campaign flow:** `site-clone` models build Clone IR → generators emit Haravan theme or standalone HTML → `haravan-campaign-matrix` drives multi-viewport cases → `anti.visual.compare` (mask ledger, normalization transaction, route identity) → `campaign-verdicts.mjs` aggregates `_verdicts.json`.\n\n**Super Core flow:** `core.*` capabilities → lazy Core port → `packages/super-core` SQLite store; outcomes ingest as pending candidates, never auto-promoted; adjudication requires explicit authority.\n\n## 4. Unresolved Technical Questions & Architectural Risks\n\n**Open ledger defects (plans/bottlenecks.json, machine-checked):**\n- **B19 (P1)**: canary settle gate counts childList mutations — a per-second carousel never yields the required 1500ms quiet window; predicate is fragile.\n- **B20 (P2)**: CDP full-page capture ceiling 16384px → taller pages degrade to main-thread tiled composite (seam risk unverified).\n- **B23 (P1)**: no live-storefront gate — flagship clone-fidelity claims still rest on human report reading; last campaign verdict INCONCLUSIVE.\n- **B29 (P2)**: 23 `anti.*` routing rows in the MCP proxy shadow catalogue-registered names with divergent defaults; each removal is a behavior change needing per-row proof.\n- **B30 (P1)**: `anti.visual.compare` normalization apply exceeds its 15s bound → CAPTURE_INVALID on desktop/tablet campaign cases while structure matches exactly — the clone-verification loop cannot currently adjudicate.\n- **B32 (P1)**: published `_verdicts.json` is not revision-bound (null exit/finishedAt/routeIdentity on adjudicated cases) — no tally from it may be quoted as evidence about HEAD.\n- **B21 (P3)**: repo root hygiene (57 PNGs, scratch files).\n\n**Structural risks identified this pass:**\n1. **God-objects**: `native-tab-host.ts` (~7.6k lines), `browser-control-port.ts` (~6.5k), `tab-devtools-host.ts` (~3.4k), `bridge-server.ts` (~3.1k), `tab-automation-host.ts` (~2.5k). The BrowserHostPort interface alone is ~100 methods; every browser capability funnels through one class, making the port the single point where target fencing, evidence staging, and CDP access intersect — high blast radius for regressions.\n2. **Dual MCP namespaces**: in-process `antifan_*` tools (mcp-server.ts) vs proxy `anti.*`/`browser_*` tools (antifan-omp-mcp.cjs) overlap in capability but diverge in naming, defaults, and schema — B29 is one symptom; the static definition table in the proxy is hand-maintained against the catalogue and can drift.\n3. **Hardcoded host paths**: `E:\\Work` roots in `workspace-resolver.ts` and the default-workspace fallback in `index.ts` tie workspace resolution to one machine layout; non-Windows or differently-rooted installs silently resolve no workspace (fail-closed, but feature-dead).\n4. **Singleton sprawl**: TerminalManager, HistoryManager, LocalSessionVault, SkillScanner, OAuthPopupManager, InjectedScriptStore are global singletons; TerminalManager is documented canonical-single, others are convenience singletons — multi-instance tests and capsule isolation must route around them.\n5. **Platform contract tension**: `themes/roahtrip-haravan` ships `sections/*.liquid`, `templates/index.json`, and `locales/` while `specs/base-theme-contract.json` lists sections/JSON templates as unsupported Haravan constructs — either the theme targets a different platform mode or the contract needs a mode dimension; unresolved which is authoritative.\n6. **Deferred bridge window**: bridge/IPC start ~1.5s after first paint; early agent connections in that window fail-closed — intentional, but orchestrators must retry rather than treat refusal as fatal.\n7. **Durability model**: EventStore/InvocationLedger/ReceiptStore are JSONL files with tail-repair-on-read; torn mid-line writes are handled, but there is no fsync journal — a power loss between append and flush can lose the last frame (mitigated by idempotent re-claim, worth confirming under crash-soak).\n8. **iOS-only device plane**: usbmux/WDA path has no Android counterpart; `device.*` capabilities fail closed with CAPABILITY_NOT_FOUND when no adapter registers.\n9. **Eval gate**: `ALLOW_EVAL` requires explicit opt-in but eval-risk capabilities exist in the catalogue; safety rests entirely on policy-freeze validation and grant checks — a registration bug is the only failure mode between opt-in and arbitrary JS.\n10. **Test architecture note**: canary lane (`test/unit/*.test.mjs`) runs uncompiled JS against `scripts/lib`; main lanes run `.compiled` output — two coverage surfaces that must both stay green for a claim to be verified."
}