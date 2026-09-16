# Scout Report (Ultra) — AntiFan Browser Desktop, Full Codebase

**Date:** 2026-09-15
**Target:** `antifan-browser-desktop` v1.3.6 (`C:\Users\Admin\AppData\Local\Temp\antifan-head`)
**Mode:** `ak:scout --ultra` (best-of-5 verifier mode)
**Finalizer:** evidence-validated, deduplicated **union** of scouted findings (scout never selects a single winner — a path may surface in only one candidate).

---

## 0. Run Provenance & Controller Validation

| Stage | Detail |
|---|---|
| Candidates dispatched | 5 parallel read-only `scout` subagents, one identical evidence packet, one wave (`Candidate1..5`) |
| Usable-candidate gate | **5/5 usable** (no terminal error, non-empty, skill-shaped). No re-dispatch needed. |
| Anonymization | Candidates relabeled **A–E** under a private controller mapping before judging; self-ratings stripped |
| Verifier | `KongmingVerifier` (Kongming), read-only scoring + union construction |
| Tier note | Same-tier best-of-5 on role-typed subagents (independent samples + rubric selection), not asymmetric verification |
| Controller materialization | Union written here; 7 unvalidatable paths dropped and replaced; all quantitative claims re-verified against disk |

### 0.1 Controller re-verification of the union (independent of the verifier)

| Claim | Verdict | Evidence |
|---|---|---|
| `ISOLATED_AGENT_WORLD_ID === 1004` | ✅ | `src/main/browser/semantic-ref-types.ts:9` → `export const ISOLATED_AGENT_WORLD_ID = 1004;` (999 is the Electron preload world) |
| `native-tab-host.ts` ≈ 7,600 lines | ✅ | `wc -l` → **7600** |
| `browser-control-port.ts` ≈ 6,506 lines | ✅ | `wc -l` → **6506** |
| `tab-devtools-host.ts` ≈ 3,365 lines | ✅ | `wc -l` → **3365** |
| `bridge-server.ts` ≈ 3,129 lines | ✅ | `wc -l` → **3129** |
| `tab-automation-host.ts` ≈ 2,488 lines | ✅ | `wc -l` → **2488** |
| `control-plane-contracts.ts` = 1,029 lines | ✅ | `wc -l` → **1029** |
| `SessionDeliveryJournal` = 2 MiB bound | ✅ | `src/main/browser/terminal-manager.ts:76-79` → `MAX_BYTES = 2 * 1024 * 1024` |
| MCP stdio client ceiling = 240 s | ✅ | `scripts/antifan-omp-mcp.cjs:595` → `DEFAULT_CLIENT_TIMEOUT_MS = 240000;` |
| Bridge ports 20129 / 20130 | ✅ | `src/main/bridge/bridge-server.ts:187,253` → `port = 20129`, dev → `20130` |
| Hardcoded `E:\Work` roots | ✅ | `src/main/index.ts:604`, `src/main/browser/native-tab-host.ts:839`, `src/main/browser/workspace-resolver.ts:10-14` (`DEFAULT_WORKSPACE_ROOTS`) |
| `plans/bottlenecks.json` open set | ✅ | 36 rows; **open = B19, B20, B21, B23, B29, B30, B32** (all others `closed`/`refuted`) |

### 0.2 Corrections applied to the union (7 unvalidatable paths dropped)

The verifier's union carried 7 paths that **do not exist on disk**. Each was dropped and, where the concept is real, replaced with the actual owner file:

| Dropped (does not exist) | Verified reality |
|---|---|
| `src/main/session/session-delivery-journal.ts` | Class lives in **`src/main/browser/terminal-manager.ts:76`** (`export class SessionDeliveryJournal`) |
| `src/main/bridge/remote-companion-server.ts` | Mobile remote companion is **`src/main/bridge/mobile-remote-html.ts`**; `src/main/bridge/` holds only `bridge-server.ts`, `annotation-manager.ts`, `qr-generator.ts`, `mobile-remote-html.ts` |
| `src/main/bridge/ws-protocol-adapter.ts` | No such module; WS framing/JSON-RPC validation lives inside `bridge-server.ts` |
| `packages/plugin-sdk/package.json` | `packages/plugin-sdk/` holds only `tsconfig.json` + `manifest-types.ts` (types-only package, no runtime) |
| `packages/site-clone/src/models/component-contract.ts` | Real models: `clone-ir.ts`, `clone-ir-builder.ts`, `blueprint-extractor.ts`, `ecommerce-data-modeler.ts`, `state-synthesizer.ts`, `responsive-scanner.ts`, `page-manifest.ts`, `asset-harvester.ts`, `asset-localizer.ts`, `dom-tree-parser.ts` |
| `packages/site-clone/src/qa/campaign-runner.ts` | Real QA modules: `haravan-campaign-matrix.ts`, `dod-validator.ts`, `final-provenance-ledger.ts`, `clean-tab-probe.ts`, `clean-tab-protocol.ts`, `mutation-qa-harness.ts`, `interaction-suite.ts`, `interaction-materialization.ts`, `control-state-journeys.ts`, `canvas-masking-helper.ts` |
| `test/unit/native-tab-host.test.mjs` | Real suites: `test/unit/native-tab-host-viewport.test.ts`, `test/unit/browser/native-tab-host-title-coalescing.test.ts`, `test/main/native-tab-host-agent-lifecycle.test.ts`, `test/main/split-review-tabhost.test.ts` |

Every other path in §2 below was confirmed present on disk by direct filesystem enumeration.

---

## 1. Executive Architecture Summary

AntiFan Browser Desktop is an **Electron 43.4 local control plane** — a Chromium host plus a capability catalogue exposed to external AI agents over three transports — engineered for autonomous theme engineering and verification of Haravan / Shopify / Sapo storefronts. It wraps no external Playwright/Puppeteer daemon; Chromium runs in-process as native `WebContentsView` instances.

### The three transports (one capability catalogue)

| Transport | Entry | Namespace |
|---|---|---|
| In-process MCP | `src/main/mcp/mcp-server.ts` | `antifan_*` |
| Standalone stdio MCP proxy → WebSocket bridge | `scripts/antifan-omp-mcp.cjs` → `src/main/bridge/bridge-server.ts` (127.0.0.1:20129 prod / 20130 dev) | `anti.*`, `device.*`, `core.*`, `theme.*`, `storefront.*` |
| Windows Native Messaging pipe | `src/main/native-messaging/local-ipc-server.ts` + `host-runner.ts` | bridge-companion (Chrome/Brave extension) |

### The seven execution planes

```
1. EXTERNAL AGENT PLANE     OMP / Claude Code / Codex / Cursor / Antigravity
2. INGRESS & BRIDGE PLANE   antifan-omp-mcp.cjs (176 tools, 240s ceiling)
                            antifan-agent.cjs (lease acquisition) · BridgeServer · native-messaging pipe
3. CONTROL PLANE            ControlPlaneRuntime · CapabilityCatalogue (frozen policies)
                            InvocationLedger (WAL + SHA-256) · ArtifactStore (CAS) · Super Core
4. BROWSER & TERMINAL       NativeTabHost (WebContentsView) · TabAutomationHost · TabDevToolsHost
                            SemanticRefRegistry (@e1..@eN) · TrackerIsolation · TerminalManager (node-pty)
5. TIER-2 DEVICE PLANE      DeviceManager (deviceEpoch) · UsbmuxClient · UsbmuxForwarder
                            WdaRestClient (127.0.0.1:8100) · IosDeviceAdapter (per-UDID mutex)
6. THEME QA & MUTATION      ThemeMutationSession (R0 snapshot) · ThemeQaWorkflow (scanners + HS gate rules)
                            WorkspaceSnapshotRollback (byte restore, no git) · HaravanSyncBarrier
7. EVIDENCE & VERIFICATION  VerificationEvaluator · CaptureSettleGate · VisualCaptureSpace + MaskLedger
                            packages/site-clone (DomTreeParser → IR → Haravan compiler / offline HTML)
```

### Core architectural pillars

1. **Dual-Plane Runtime Isolation.** Human interactive browsing (foreground `WebContentsView`) is decoupled from autonomous agent execution. Agents provision an isolated offscreen tab with a dedicated partition; `BridgeServer` defaults `browserTarget: undefined` for user tabs, so an agent can never ambiently latch onto the user's foreground tab.
2. **Generation & Mutation Fencing.** Monotonic `browserEpoch` (target lifetime), `documentGeneration` (navigation/reload) and `mutationRevision` (DOM writes). Effectful capabilities assert `tabId` + epoch + generation and throw `TARGET_STALE` otherwise.
3. **Single Terminal Authority.** One composition-root `TerminalManager` over `node-pty`/ConPTY, with a 2 MiB / 4096-chunk in-memory `SessionDeliveryJournal`, `chunkSeq`/`sessionGeneration` delta re-sync, and recursive process-tree teardown.
4. **Tier-2 Physical Reality.** Real iOS hardware over `usbmuxd` TCP + WebDriverAgent REST — no Appium. `deviceEpoch` (USB re-plug) is fenced separately from `sessionGeneration` (WDA restart).
5. **Deterministic Verification Substrate.** Claims are adjudicated by `VerificationEvaluator` against fresh mechanical evidence. Verification engines never mutate the workspace; only the path-scoped R0 restore may write.
6. **Local Knowledge Store.** `packages/super-core` — embedded SQLite (WAL, schema v5, FTS5) for claims, anti-patterns, experience graph and decision receipts. Ingestion lands candidates as **pending**; promotion requires explicit adjudication.

---

## 2. Verified Subsystem & File Directory

### A. Bootstrap, Configuration & Lifecycle

- `package.json` — v1.3.6 manifest: Electron 43.4.0, node-pty, ws, MCP SDK, zod; compile chain (shim → emit-integrity → tsc → MCP budget dominance → orphan prune → static copy → extension build); multi-lane test pipelines.
- `src/main/index.ts` — Composition root (36.8 KB): privileged `antifan-preview://` scheme, single-instance lock, crash reporter, profile lease, deferred (~1.5 s post-paint) control-plane + bridge startup, dual-plane target binding. `:604` holds the `E:/Work` fallback.
- `src/main/config/storage-locations.ts` — Cross-platform resolver for user data, capsules, profile partitions, crash dumps, artifact caches.
- `src/main/diagnostics/main-lifecycle-log.ts` — Synchronous boot-milestone/heartbeat/shutdown logger.
- `src/main/benchmark/telemetry.ts` — Event-loop lag, RSS and operation-duration collector.
- `src/main/telemetry/fallback-recorder.ts` — Records sanitized telemetry when an AntiFan capability fails and Playwright is used as fallback.
- `src/main/chat/chat-store.ts` — Local multi-turn chat/prompt persistence.

### B. Tab Host, Navigation & Automation (`src/main/browser/`)

- `native-tab-host.ts` — **7,600 lines**. Central tab controller: `WebContentsView` layering, tab lifecycle, split review, DevTools docking, URL sanitization, preview watcher, capsule partitions, agent-working state, terminal tab affinity.
- `tab-automation-host.ts` — **2,488 lines**. Synthetic input: semantic-ref resolution, isolated-world-1004 execution, CDP trusted click/type/hover/drag, action sequences, file upload/drop, occlusion fail-closed gate.
- `tab-devtools-host.ts` — **3,365 lines**. CDP client: eval, screenshots, isolated-world contexts, tracker-isolation apply/teardown, in-page tools (lens, ruler, picker, font finder).
- `terminal-manager.ts` — **1,795 lines**. Canonical singleton `node-pty` host; `SessionDeliveryJournal` (`:76`, 2 MiB / 4096-chunk bound), generation+seq delta sync, process-tree kill, bridge endpoint identity.
- `split-review-coordinator.ts` — Dual-pane desktop (1440 px) / mobile (390 px) geometry and loop-guarded navigation mirroring.
- `semantic-ref-registry.ts` — Main-owned `@e1..@eN` allocation, snapshot lifecycle, exact-target descriptor resolution with epoch/generation/URL validation.
- `semantic-ref-executor.ts` — Isolated-world (1004) script builder: traversal-path resolution, fingerprint matching, mutation guards.
- `semantic-ref-types.ts` — Descriptor/envelope contracts; `ISOLATED_AGENT_WORLD_ID = 1004` (`:9`), `MAX_SNAPSHOT_DESCRIPTORS = 150`, `MAX_TOTAL_SERIALIZED_BYTES = 512 KB`, `MAX_LABEL_LENGTH = 60`.
- `agent-browser.ts` — Main-world visual agent cursor / overlay / banner / highlight injected script.
- `target-operation-chain.ts` — Per-tab FIFO enforcing generation + revision freshness fencing.
- `annotation-dispatch.ts` — Routes visual user annotations into active PTY sessions as formatted prompts.
- `keyboard-normalizer.ts` — Raw key/modifier → Electron `InputEvent` descriptors.
- `device-presets.ts` — Emulation presets: geometry, DPR, user agent, touch flags.
- `window-state.ts` — Window geometry restore/persist with multi-monitor sanity checks.
- `tab-zoom-controller.ts` — Zoom factor control/clamping for desktop + mobile panes.
- `app-menu.ts` — Application menu, shortcuts, DevTools toggles.
- `tab-context-menu.ts` — Context menu: inspect, save image, Haravan CDN upload hooks.
- `browser-action-registry.ts` — Registry of in-page browser actions.
- `tab-diagnostics.ts` — Per-tab ring buffers for console messages, uncaught exceptions, failed requests.

### C. CDP Scripts, Inspectors & Network Policy

- `scripts/injected-script-store.ts` — Hot-reloadable CDP script registry; disk overrides via `ANTIFAN_CDP_SCRIPTS_DIR` / `scripts/cdp`.
- `scripts/advanced-inspection-scripts.ts` — Isolated-world builders for computed styles, spatial region, font metrics.
- `element-picker.ts` — Hover highlight, multi-element picking, annotation modals.
- `font-finder.ts` — Shadow-DOM–aware typography inspection.
- `gpu-lens.ts` — Canvas magnifier: pixel zoom + hex sampling.
- `ruler.ts` — Pixel alignment ruler + 8 px/64 px grid overlay.
- `haravan-uploader.ts` — Storefront asset inspection and CDN upload preparation.
- `css-cascade-analyzer.ts` — `CSS.getMatchedStylesForNode` cascade analysis (active vs overridden, specificity).
- `zero-network-interceptor.ts` — `Fetch.requestPaused` zero-external-network barrier with deterministic drain.
- `network-policy.ts` — Local-vs-external URL classifier; blocks host-prefix spoofing (`localhost.evil.com`) and non-http(s) schemes.
- `tracker-isolation.ts` — Ephemeral analytics/tracking blocker (GTM, FB Pixel, Haravan analytics) for noise-free QA.
- `first-party-network-tracker.ts` — In-flight first-party request tracking feeding settle gates.

### D. Profile Ownership, Vaults, Sessions & Tenancy

- `profile-ownership.ts` — Chromium user-data lease; single-instance lock, PID checks, clean-shutdown markers.
- `browser-session-partition.ts` — Partition derivation (`persist:profile-*`, `persist:capsule-*`, ephemeral) + header/cache ceilings.
- `capsule-partition-migration.ts` — Legacy capsule partition → unified profile migration.
- `chrome-profile-sync.ts` — Imports Chrome/Brave cookies and bookmarks with Windows epoch translation.
- `local-session-vault.ts` — Encrypted session-state / cookie / localStorage vault for offline replay.
- `local-credential-vault.ts` — DPAPI-encrypted credential vault with frame-origin verification.
- `oauth-popup-manager.ts` — OAuth popup interception (Google, Facebook) with token sync and popup-chain leak prevention.
- `google-auth-identity.ts` — UA / Client Hints spoofing engine enabling Google OAuth inside Electron.
- `history-manager.ts` — SQLite-backed history with FTS, visit frequency, omnibox suggestions.
- `tab-bookmarks-manager.ts` — Bookmarks and folder hierarchies.
- `workspace-resolver.ts` — URL → workspace classification; `DEFAULT_WORKSPACE_ROOTS` (`:10-14`) hardcodes `e:\Work\{customizes,themes,apps}`.
- `theme-source-mapper.ts` — Maps rendered DOM elements back to Liquid source files.
- `skill-scanner.ts` — Scans local agent skill dirs (`~/.gemini`, `.cursor/rules`, workspace rules).
- `src/main/project/workspace-capsule.ts` — Multi-project workspace configs and preview ports.
- `src/main/project/workspace-registry.ts`, `project-registry.ts` — Active workspace / project index.

### E. Control Plane, Tenancy & Capability Transport

- `src/main/control-plane/control-plane-runtime.ts` — **29.0 KB**. Binds project/workspace registries, chat stores, ledgers, receipt stores, artifact stores, catalogue and terminal managers.
- `src/main/tools/capability-catalogue.ts` — Central frozen-policy registry (632 lines): execution policies, `duplicateMode`, risk categories, scheduler lanes.
- `src/main/tools/capability-transport.ts` — **935 lines**. Dispatch adapter: child intents, execution-control phases, cancellation tokens, continuation acks.
- `src/main/tools/browser-control-port.ts` — **6,506 lines**. Monolithic browser capability facade (~100 methods) between dispatch and `NativeTabHost`.
- `src/main/tools/artifact-store.ts` — CAS engine: per-run byte budgets, evidence leases, SHA-256 digests.
- `src/main/tools/artifact-retention-cleaner.ts` — Retention sweeper (prunes ephemeral captures, preserves reports).
- `src/main/tools/workspace-file-port.ts` — Path-containment sandbox; symlink rejection.
- `src/main/tools/required-args.ts` — Required-argument contract assertion before dispatch.
- `src/main/tools/browser-capabilities.ts` — Browser interaction capability registrations.
- `src/main/tools/file-capabilities.ts` — Sandboxed `file.read` / `file.write`.
- `src/main/tools/terminal-capabilities.ts` — Terminal lifecycle, input, stream, resize.
- `src/main/tools/device-capabilities.ts` — Physical iOS device capabilities bound to `IosDeviceAdapter`.
- `src/main/tools/core-capabilities.ts` — Super Core query / context pack / receipt / experience graph.
- `src/main/tools/theme-transaction-capabilities.ts` — Atomic theme mutation (`begin`, `write_files`, `commit`, `rollback`).
- `src/main/tools/artifact-capabilities.ts` — Artifact read/stat/list capabilities.
- `src/main/tools/theme-evidence-envelope.ts` — Standardized theme evidence JSON envelope.
- `src/main/tools/adapters/tree-walker-sanitizer.ts` — Sanitizes third-party tracker DOM nodes before inspection.

### F. Session Stores, Ledgers & Journals

- `src/main/session/invocation-ledger.ts` — **860 lines**. Append-only WAL of execution frames with SHA-256 integrity checksums and crash replay.
- `src/main/session/receipt-store.ts` — Durable authoritative verification receipts / decision proofs.
- `src/main/session/event-store.ts` — Append-only JSONL event log with lineage validation and crash tail repair.
- `src/main/session/issue-register.ts` — Persistent verified-defect register across sessions.
- `src/main/session/run-recovery.ts` — Startup reconciliation of crashed/unfinalized runs.
- `src/main/run/run-service.ts` — Run lifecycle, leases, run-scoped artifact budgets.
- `src/main/run/attachment-registry.ts` — **1,077 lines**. Agent session tracking: ephemeral tokens, authority revisions, tab bindings (also hosts the dual-plane binding contract).

### G. Bridge, Ingress & Agent Execution Backends

- `src/main/bridge/bridge-server.ts` — **3,129 lines**. Authenticated WebSocket RPC (20129/20130), pairing queue, token grants, mobile remote companion.
- `src/main/bridge/annotation-manager.ts` — Stores/formats user annotations, element picks, canvas markup.
- `src/main/bridge/mobile-remote-html.ts` — Mobile-friendly remote companion UI (QR-paired phone preview).
- `src/main/bridge/qr-generator.ts` — Pairing QR rendering.
- `src/main/mcp/mcp-server.ts` — **899 lines**. In-process MCP server exposing native `antifan_*` tools.
- `src/main/mcp/result-envelope.ts` — MCP result envelope shaping.
- `src/main/native-messaging/local-ipc-server.ts` — Windows Named Pipe server for the browser extension.
- `src/main/native-messaging/local-ipc-client.ts` — Named Pipe client counterpart.
- `src/main/native-messaging/manifest-installer.ts` — Registry registration of Native Messaging manifests (Chrome/Edge/Brave).
- `src/main/native-messaging/host-runner.ts` — Lightweight native-host launcher.
- `src/main/native-messaging/framing.ts` — Native Messaging length-prefixed framing.
- `src/main/agent/execution-backend.ts` — Subagent process-spawn / stdio / env-injection interface.
- `src/main/agent/codex-execution-backend.ts` — Concrete backend launching external agent CLIs with `ANTIFAN_MCP_BOOTSTRAP` credentials.
- `src/main/agent/deepseek-harness-adapter.ts` — Harness adapter for DeepSeek-style backends.
- `src/main/agent/session-resume-controller.ts` — Agent session resume orchestration.

### H. Security, Preview Serving & Device Plane

- `src/main/security/windows-acl.ts` — Strict DACLs on pipes/directories via `icacls`.
- `src/main/security/security-policy.ts` — CSP, allowed URI schemes, secure `WebPreferences`.
- `src/main/server/preview-protocol-handler.ts` — `antifan-preview://` handler serving sandboxed workspace files.
- `src/main/server/safe-fs-resolver.ts` — Traversal-proof path containment for preview serving.
- `src/main/server/preview-url-codec.ts` — Preview URL encode/decode.
- `src/main/server/preview-watcher-pool.ts` — Pooled dev-server file watchers.
- `src/main/device/device-manager.ts` — Physical device connections, UDIDs, monotonic `deviceEpoch`.
- `src/main/device/ios-device-adapter.ts` — **36.2 KB**. Serialized WDA driver; per-UDID single-flight mutex; screen capture staging.
- `src/main/device/wda-rest-client.ts` — **20.3 KB**. WebDriverAgent REST client (iPhone port 8100).
- `src/main/device/usbmux-client.ts` — **26.0 KB**. Zero-dependency XML-plist client over USB multiplexer.
- `src/main/device/usbmux-forwarder.ts` — Loopback (127.0.0.1:8100) → usbmuxd tunnel.
- `src/main/device/device-readiness.ts` — Attachment / trust / Developer Mode / UI Automation / WDA liveness gates.
- `src/main/device/ios-session-manager.ts` — WDA session lifecycle vs physical attachment epoch separation.
- `src/main/device/device-control-port.ts` — Device control facade.
- `src/shared/device-control-contracts.ts` — Device target/binding contracts, tri-state gates, remediation codes.

### I. Theme QA, Scanners & Transactional Mutation

- `src/main/qa/theme-qa-workflow.ts` — **1,363 lines**. End-to-end orchestrator: scanners, differential attribution, report generation.
- `src/main/qa/theme-mutation-session.ts` — Transactional workspace session: R0 disk snapshots, CAS writes, atomic rollback.
- `src/main/qa/theme-transaction-registry.ts` — In-flight mutation sessions; exclusive workspace locks.
- `src/main/qa/workspace-snapshot-rollback.ts` — Byte-level snapshot/restore (per-file SHA-256, fail-closed on symlinks, **no git**).
- `src/main/qa/haravan-sync-barrier.ts` — Awaits local Haravan/Shopify CLI watcher compilation before re-verify.
- `src/main/qa/theme-qa-repair-coordinator.ts` — Automated targeted repair inside a transaction.
- `src/main/qa/diagnostics-filter.ts` — Diagnostic noise filtering for QA verdicts.
- `src/main/qa/async-qa-job-queue.ts` — Async QA job queue.
- `src/main/qa/scanners/platform-detector.ts` — Haravan DotLiquid vs Shopify OS 2.0 vs Sapo detection.
- `src/main/qa/scanners/liquid-error-scanner.ts` — DotLiquid AST scanner (unsupported filters, missing tags, syntax).
- `src/main/qa/scanners/server-crash-scanner.ts` — Console/network burst crash detection.
- `src/main/qa/scanners/broken-asset-scanner.ts` — 404 / empty / broken-dimension / font-failure probes.
- `src/main/qa/scanners/layout-overflow-engine.ts` — Overflow / clipping / scroll bugs at 1440, 1024, 390 px.
- `src/main/qa/rules/hs-gate-rules.ts` — HS gate rules: platform-migration compatibility invariants (cart contract, endpoints, noPS).

### J. Verification Engine, Settle & Visual Capture

- `src/main/verification/verification-evaluator.ts` — Deterministic claim adjudicator (freshness, completeness, thresholds).
- `src/main/verification/verification-contract.ts` — Claims, proof profiles, freshness metrics, binary verdicts.
- `src/main/verification/visual-capture.ts` — **1,516 lines** (60.0 KB). Affine CSS→raster geometry, capture tiles, `CAPTURE_MAX_DIMENSION = 16384`.
- `src/main/verification/visual-region.ts` — Spatial bounds, z-index stacking, section inventory.
- `src/main/verification/capture-settle.ts` — Composed settle barrier: DOM quiescence, fonts, image decode, network idle.
- `src/main/verification/scroll-prewarm.ts` — Staircase scroll prewarm for lazy-loaded images.
- `src/main/verification/baseline-authority.ts` — Baseline screenshots, golden DOM, authoritative masks.
- `src/main/verification/interaction-delta.ts` — DOM/CSS/layout deltas from synthetic actions.
- `src/main/verification/interaction-contract.ts` — Interaction trace contracts.
- `src/main/verification/mutation-attribution.ts` — Correlates layout shifts/console errors to source edits.
- `src/main/verification/circuit-breaker.ts` — Halts runs on recurring crash cascades / loops.
- `src/main/verification/modular-gates.ts` — A11y / performance / responsive gate runner.
- `src/main/verification/stability-policy.ts` — Stability thresholds policy.
- `src/main/verification/proof-templates.ts` — Proof obligation templates.
- `src/main/verification/theme-proof-helpers.ts` — Theme-specific proof helpers.
- `src/main/workflow/workflow-engine.ts` — Declarative verification/repair state machine.
- `src/main/workflow/workflow-schema.ts`, `workflow-registry.ts`, `workflow-capabilities.ts` — Workflow schema, versioned registry, agent-facing bindings.

### K. Presentation Layer

- `src/renderer/toolbar.ts` — **2,592 lines**. Browser chrome: tab strips, split view, device selection, QA triggers.
- `src/renderer/toolbar.html` (36.8 KB), `toolbar.css` (60.3 KB) — Dark VS Code–styled toolbar markup and styling.
- `src/renderer/standalone.js` — **2,802 lines**. Standalone viewer: clone playback, delta re-sync, diff reports.
- `src/renderer/standalone.html`, `standalone.css`, `standalone-overrides.css` — Standalone viewer shell.
- `src/renderer/frame-backdrop.ts` / `.html` / `.css` — Physical phone bezel + shadow backdrop for mobile panes.
- `src/renderer/terminal-write-dispatcher.js` — Renderer-side chunked write dispatcher.
- `src/renderer/exports-shim.js` — Renderer export shim.
- `src/preload/toolbar-preload.ts` — `contextBridge` exposing `antifan:toolbar:*` typed IPC.
- `src/preload/tab-preload.ts` — Tab preload: stealth properties, Haravan JSON view formatting.
- `src/preload/standalone-preload.ts`, `frame-backdrop-preload.ts` — Viewer/backdrop IPC surfaces.
- `src/extension/background.ts`, `domain-scoper.ts`, `cookie-debouncer.ts` — Companion extension (source); `extension/background.js` (182 KB) is the built artifact.
- `extension/popup.html` / `popup.js` / `popup.css` / `manifest.json` — Extension popup and manifest.

### L. Shared Contracts

- `src/shared/control-plane-contracts.ts` — **1,029 lines**. Authoritative protocol: `CapabilityDefinition`, `RuntimeLease`, `FixRequestV2`, error codes.
- `src/shared/contracts.ts` — `AntiFanTab`, `ElementRect`, `SplitReviewState`, internal IPC channels.
- `src/shared/theme-task-context.ts` — Binds agent tasks to theme workspaces, selectors, CAS receipts.
- `src/shared/annotation-prompt.ts` — Element selection / annotation → agent instruction templates.
- `src/shared/terminal-write-dispatcher.ts` — Chunked, ack-verified terminal write transport protocol.
- `src/shared/device-control-contracts.ts` — Device contracts (see §H).

### M. Monorepo Packages

- `packages/super-core/src/index.ts` — **55.9 KB**. Local SQLite evidence store: context packs, claims, anti-patterns, decision receipts.
- `packages/super-core/src/schema.ts` — DDL, FTS5 indexing, versioned migrations (schema v5, WAL).
- `packages/super-core/src/core.test.ts` — Store regression tests.
- `packages/site-clone/src/index.ts` — Package entrypoint.
- `packages/site-clone/src/models/dom-tree-parser.ts` — DOM → normalized component tree.
- `packages/site-clone/src/models/clone-ir.ts`, `clone-ir-builder.ts` — `ComponentContractIR` definitions and construction.
- `packages/site-clone/src/models/blueprint-extractor.ts` — Structural blueprint extraction.
- `packages/site-clone/src/models/ecommerce-data-modeler.ts` — Collections/products/variants/price models.
- `packages/site-clone/src/models/state-synthesizer.ts` — Interaction state synthesis.
- `packages/site-clone/src/models/responsive-scanner.ts` — Multi-viewport layout scanning.
- `packages/site-clone/src/models/page-manifest.ts` — Per-page manifest.
- `packages/site-clone/src/models/asset-harvester.ts`, `asset-localizer.ts` — Asset download, hashing, URL rewriting for offline bundles.
- `packages/site-clone/src/generators/theme-compiler.ts` — Atomic Haravan flat-directory DotLiquid theme compiler.
- `packages/site-clone/src/generators/haravan-layout-generator.ts`, `haravan-snippet-generator.ts`, `haravan-schema-generator.ts`, `haravan-legacy-settings-generator.ts` — Haravan target generators.
- `packages/site-clone/src/generators/liquid-binding-engine.ts` — Liquid binding/data wiring.
- `packages/site-clone/src/generators/settings-assets-normalizer.ts` — Settings/asset normalization.
- `packages/site-clone/src/generators/haravan-target-contract.ts` — Haravan target contract.
- `packages/site-clone/src/generators/independent-html-clone-generator.ts` — Self-contained offline HTML bundle generator.
- `packages/site-clone/src/platform/haravan/haravan-adapter.ts`, `store-discovery.ts`, `route-resolver.ts`, `entity-resolver.ts`, `types.ts`, `index.ts` — Haravan platform adapter surface.
- `packages/site-clone/src/qa/clean-tab-probe.ts`, `clean-tab-protocol.ts` — Clean-tab interaction probes.
- `packages/site-clone/src/qa/mutation-qa-harness.ts` — Mutation robustness harness.
- `packages/site-clone/src/qa/haravan-campaign-matrix.ts` — Multi-page campaign matrix.
- `packages/site-clone/src/qa/dod-validator.ts` — Definition-of-done validator.
- `packages/site-clone/src/qa/final-provenance-ledger.ts` — Provenance ledger for final artifacts.
- `packages/site-clone/src/qa/interaction-suite.ts`, `interaction-materialization.ts`, `control-state-journeys.ts`, `canvas-masking-helper.ts` — Interaction coverage and masking.
- `packages/site-clone/src/schemas/` — `clone-spec.schema.json`, `clone-ir.schema.json`, `qa-matrix.schema.json`.
- `packages/plugin-sdk/manifest-types.ts` — Declarative plugin/capability extension types (types-only package; no `package.json`, no in-tree runtime).

### N. Scripts, Build Gates & CLI Entrypoints

- `scripts/antifan-omp-mcp.cjs` — **26.7 KB**. Standalone stdio MCP proxy; `DEFAULT_CLIENT_TIMEOUT_MS = 240000` (`:595`).
- `scripts/antifan-agent.cjs` — Agent launcher: bridge discovery, lease acquisition, credential injection.
- `scripts/antifan-core.cjs` — Super Core CLI (query / update / snapshot).
- `scripts/check-mcp-budget-dominance.mjs` — Build gate: client ceiling must dominate every capability policy; reports shadowing rows.
- `scripts/check-emit-integrity.mjs` — Emit-integrity gate.
- `scripts/prune-orphan-emit.mjs` — Orphan emit pruning.
- `scripts/check-bottlenecks.mjs` — Verifies every `plans/bottlenecks.json` predicate against HEAD.
- `scripts/check-plans.mjs` — Plan document validation.
- `scripts/run-test-pipeline.mjs` — Master test orchestrator (`--verify` mode).
- `scripts/launch-guard.cjs` — Blocks stale-`.compiled` launches by mtime comparison.
- `scripts/build-native-host-shim.mjs`, `build-extension.mjs`, `copy-static.mjs` — Build steps.
- `scripts/lib/campaign-verdicts.mjs` — Campaign verdict aggregation (`:241`, `:272`).
- `scripts/lib/evidence-provenance.mjs` — SHA-256 + git-commit provenance validation.
- `scripts/verify-all-visual-compare.mjs` (21.0 KB), `theme-checks.mjs`, `lint-haravan-theme.mjs` — Verification/lint runners.
- `scripts/run-electron.cjs` — Electron launcher for smoke scripts.

### O. Themes, Specs & Test Architecture

- `specs/base-theme-contract.json` — 64.5 KB machine-readable Haravan DotLiquid platform contract (limits, forbidden filters, `unsupportedConstructs`).
- `specs/qa-matrix.json` — 8-dimension QA scoring matrix.
- `specs/roahtrip-html-spec/` — Route-level HTML specifications.
- `themes/universal-haravan-base/` — Baseline flat-directory Haravan theme (templates, snippets, layout, config, assets).
- `themes/roahtrip-haravan/` — OS 2.0–style demonstration theme (sections, locales, `templates/index.json`).
- `test/unit/` — Fast lane: `.test.mjs` + `.test.ts` (viewport gates, canary contracts, build-report gates, bundle integrity).
- `test/main/` — Main-process lane (~130 suites): tabhost, terminal, theme QA, control plane, verification, security.
- `test/integration/`, `test/e2e/`, `test/benchmark/`, `test/renderer/`, `test/fixtures/` — Remaining lanes.
- `plans/bottlenecks.json` — Machine-checkable defect ledger (36 rows; §4).

---

## 3. Cross-Boundary Data Flows

### Flow 1 — Dual-Plane isolation & agent tool invocation

```
Agent process (OMP / Claude / Cursor)
  → stdio JSON-RPC
scripts/antifan-omp-mcp.cjs                    (240 s client ceiling enforced)
  → ws://127.0.0.1:20129, Bearer secret
BridgeServer                                    (validate AttachmentToken; authorityRevision)
  → dual-plane rule: refuse to bind agent to user foreground tab
ControlPlaneRuntime                             (frozen policy: lane, duplicateMode, risk)
  → InvocationLedger records pending frame (WAL)
BrowserControlPort                              (assertExactBrowserTarget: tabId+epoch+generation)
  → NativeTabHost → offscreen agent WebContentsView
      ├── TabDevToolsHost        (CDP commands)
      ├── TabAutomationHost      (synthetic input kinematics)
      └── isolated world 1004    (script execution)
ArtifactStore (SHA-256) → InvocationLedger commit → ReceiptStore → back to agent
```

- **Isolation invariant:** user tabs default to `browserTarget: undefined`; agent sessions mint `createTab(url, …, { offscreen: true })`.
- **Fail-closed freshness:** any navigation mid-flight raises `TARGET_STALE`.

### Flow 2 — Terminal PTY delivery journal & sequence re-sync

```
Agent CLI / toolbar terminal UI
  → TerminalManager (canonical session) → ConPTY / node-pty slave
PTY emits stdout/stderr
  → SessionDeliveryJournal (2 MiB / 4096-chunk ring; chunkSeq++; sessionGeneration)
  → WebSocket broadcast { sessionGeneration, chunkSeq, data }
Client reconnect with lastAckSeq=1010
  → journal.getDelta(1010): if gap < buffer capacity → atomic replay 1011..N
                            else → RESYNC_REQUIRED
Session disposal → recursive process-tree termination (taskkill /T /F or job object)
```

### Flow 3 — Tier-2 physical iOS hardware (usbmuxd + WebDriverAgent)

```
device.tap({x,y})
  → device-capabilities.ts (device lease + policy; assert deviceEpoch)
  → IosDeviceAdapter (per-UDID single-flight mutex; CSS px → device points)
  → WdaRestClient (POST /session/:id/wda/touch/perform)
  → UsbmuxForwarder (127.0.0.1:8100 → tunnel)
  → UsbmuxClient (XML plist over USB multiplexer)
  → usbmuxd → iPhone → WebDriverAgent runner → Mobile Safari
  → screenshot → SHA-256 → ArtifactStore
```

- **Epoch fencing:** USB re-plug increments `deviceEpoch`; stale `DeviceTarget` → `TARGET_STALE`.
- **Crash protection:** WDA breaks under concurrent actions, hence the per-UDID mutex.

### Flow 4 — Theme mutation, CAS transactions & R0 rollback

```
theme.transaction.begin      (exclusive workspace lock; R0 manifest SHA-256/file; fail-closed on symlink)
theme.transaction.write_files (path containment; diff budgets; write Liquid/JSON)
HaravanSyncBarrier           (baseline CLI seq → await watcher compile ack)
Storefront verification      (reload preview tab → documentGeneration++; run scanners)
  ├─ PASS  → commit    (R0 released)
  └─ FAIL  → rollback  (byte-exact R0 restore; zero git commands executed)
```

### Flow 5 — Super Core knowledge & SQLite WAL

```
core.context_pack({task})
  → core-capabilities.ts → SuperCore (node:sqlite, WAL)
      FTS5 search over claims/anti_patterns
      experience_edges graph traversal from TASK node
  → enriched pack: platform semantics + anti-patterns + fix patterns with confidence/uncertainty
Agent applies fix → verifies
core.ingest_outcome → case + PENDING candidate (never auto-promoted)
promotion requires explicit core.adjudicate
```

### Flow 6 — Site-clone IR pipeline

```
Target storefront (desktop + mobile)
  → DomTreeParser (settled DOM in world 1004; strip Livewire/GTM/analytics blobs; normalize grids/fonts/CSS vars)
  → ComponentContractIR (component hierarchy, e-commerce data schemas, 1440/1024/390 layout constraints)
  → AssetLocalizer (download → SHA-256 → rewrite to relative paths for offline playback)
  → fork:
      A) IndependentHtmlCloneGenerator → self-contained HTML/CSS/JS
         proven by ZeroNetworkInterceptor (0 external packets)
      B) ThemeCompiler → Haravan flat-directory DotLiquid theme
         layout/theme.liquid · templates/*.liquid · snippets/*.liquid · config/settings_schema.json
```

---

## 4. Bottleneck Ledger & Architectural Risks

Source of truth: `plans/bottlenecks.json` (36 rows, `schemaVersion: 1`, updated 2026-09-14). Predicates are machine-checked by `scripts/check-bottlenecks.mjs`, which fails on `REOPENED`, `FIXED_UNRECORDED`, or `REFUTED_BUT_PRESENT`.

### 4.1 Open rows (verified verbatim from the ledger — 7 of 36)

| ID | Sev | Group | Defect |
|---|---|---|---|
| **B19** | P1 | theme-qa | Canary settle gate sums `addedNodes + removedNodes` and requires `quietFor >= 1500 ms` inside a 9000 ms budget — a per-second carousel never yields a quiet window, so the gate starves and capture baselines destabilize. |
| **B20** | P2 | theme-qa | Full-page capture capped at 16,384 px (Skia/CDP single-buffer limit); taller pages degrade to a main-thread tiled composite, risking vertical seam tearing when sticky/parallax elements shift between tiles. |
| **B21** | P3 | hygiene | Repository root is a dumping ground: 57 `.png`, 14 `.md`, 1 `.docx`, 2 `.log`, plus scratch `.cjs`/`.vbs`/`.js`/`.txt` — pollutes git status and agent working context. |
| **B23** | P1 | theme-qa | No live-storefront gate: rendered-fidelity claims rest on a human reading a report. `.canary/15-pages/_verdicts.json` resolves to `executiveVerdict: INCONCLUSIVE` with a zero tally and empty cases. |
| **B29** | P2 | mcp | 23 `anti.*` routing rows in the proxy redirect names the catalogue already registers, so the row — not the server — decides which implementation runs; several aliases are independent reimplementations with different defaults. `anti.browser.tabs.list` was one instance (fixed in B28). Re-verify: `node scripts/check-mcp-budget-dominance.mjs`. |
| **B30** | P1 | gate | Clone-campaign measured viewports produce no adjudicable verdict: `anti.visual.compare` reversible-normalization apply exceeds its 15,000 ms bound → `captureValid=false` → `CAPTURE_INVALID`. Evidence: run `campaign-e2214e66` — 390 refused (`MOBILE_BUNDLE_ABSENT`), 1440/1024 completed but `INCONCLUSIVE` with `mismatchPercentage=100`. Structure matched exactly (docH 5546/5546, 5422/5422; sections 15/15; cards 83/83; overflowX 0/0) while capture failed. |
| **B32** | P1 | gate | Published campaign verdict artifact is not revision-bound: `exit`, `finishedAt`, `instance` null; 24 of 45 cases carry `routeIdentity: null` yet are adjudicated PASS/FAIL. `scripts/lib/campaign-verdicts.mjs:272` writes `exit ?? null`; the runner does produce both, so nulls mean aggregation drift. No number from it may be quoted as evidence about HEAD. |

### 4.2 Structural risks identified across the candidate pool

1. **God-object concentration.** `native-tab-host.ts` (7,600) + `browser-control-port.ts` (6,506) centralize ~80 % of browser logic and ~100 host methods. Any fencing/disposal/lock regression has an exceptionally wide blast radius.
2. **Dual MCP namespace divergence.** In-process `antifan_*` vs proxy `anti.*`/`device.*`/`core.*`/`theme.*`, manually synchronized → perpetual drift (see B29).
3. **Hardcoded host paths.** `DEFAULT_WORKSPACE_ROOTS` (`e:\Work\{customizes,themes,apps}`) and the `E:/Work` fallbacks in `index.ts:604` / `native-tab-host.ts:839` silently degrade to `process.cwd()` on any machine without that layout (Linux/macOS/non-E-drive Windows).
4. **Main-thread event-loop saturation.** One process handles tab rendering, CDP events, PTY multiplexing, WebSocket serialization and SHA-256 hashing; heavy visual diffing or JSONL replay can spike >100 ms.
5. **Singleton sprawl vs test isolation.** `TerminalManager`, `HistoryManager`, `LocalSessionVault`, `SkillScanner`, `OAuthPopupManager`, `InjectedScriptStore` are global singletons — concurrent isolated integration testing needs explicit resets.
6. **Platform contract tension.** `specs/base-theme-contract.json` lists `sections/*.liquid` and `templates/*.json` as *unsupported*, yet `themes/roahtrip-haravan` ships both. There is no platform-mode dimension distinguishing Haravan classic-flat from Haravan OS 2.0.
7. **Deferred bridge startup window.** Bridge + local IPC start ~1.5 s post-paint; agent scripts connecting immediately on launch hit connection refusal and must implement retry backoff.
8. **JSONL durability.** `EventStore`, `InvocationLedger`, `ReceiptStore` append with tail-repair but **no explicit `fsync`** — abrupt power loss can drop the trailing un-flushed frame.
9. **iOS-only Tier-2 hardware.** No ADB/Android counterpart exists for the physical-device plane.
10. **Split test execution architecture.** Canary `.test.mjs` runs against uncompiled `scripts/lib` ES modules while main lanes run `.compiled/` output — editing TS without compiling passes canary against stale main-lane code.

### 4.3 Refuted rows (retained deliberately by the ledger)

Rows `B15`, `B16`, `R1`, `R2`, `R3`, `R4` are marked `refuted` and **must never be deleted** — they encode disproven hypotheses (e.g. cannot-pass settle gate, mandatory `webSecurity`, dev-port shift breaking the MCP client).

---

## 5. Unresolved Questions

1. **Is the 16,384 px capture ceiling (B20) actually hit in production runs**, and does tile composition produce measurable seam artefacts on collection pages > 16,384 px?
2. **What is the real cause of B30's 15 s normalization overrun** — page complexity, tracker isolation interaction, or the settle gate chaining — and does it invalidate every desktop/tablet clone verdict so far?
3. **Can B23 (live-storefront gate) be satisfied without hardware** — i.e. is a deterministic local-render gate acceptable, or is a live storefront mandatory for adjudication?
4. **Do the 23 `anti.*` shadowing rows (B29) change behavior** relative to their catalogue aliases? Requires per-row `omp-mcp-adapter` proof before retirement.
5. **Is `packages/plugin-sdk` intentionally runtime-free**, or is the missing `package.json`/build wiring an incomplete extraction?
6. **Should the platform contract (item 6 in §4.2) gain an explicit mode dimension**, or should `roahtrip-haravan` move to a separate OS 2.0 contract file?
7. **What is the intended non-Windows story** for `DEFAULT_WORKSPACE_ROOTS` and the `icacls`-based DACL path (`src/main/security/windows-acl.ts`) on macOS/Linux?
8. **Does the absence of `fsync` (item 8 in §4.2) matter in practice** given the ledger is replay-repaired on startup, or is a torn tail unrecoverable for receipts?

---

## Appendix A — Ultra Verifier Ranking

Rubric (1–20 each, max 80): **C1** subsystem coverage · **C2** path accuracy & evidence quality · **C3** signal density & architecture tracing · **C4** honesty about gaps & bottlenecks.

| Rank | Candidate | C1 | C2 | C3 | C4 | Total | Verdict |
|:---:|:---|:---:|:---:|:---:|:---:|:---:|:---|
| 1 | **A** | 20 | 20 | 20 | 20 | **80** | **Winner** — exhaustive inventory, 100 % path accuracy, unmatched depth, complete bottleneck coverage |
| 2 | C | 16 | 18 | 17 | 16 | **67** | Conditional — solid core; missed B21/B23, auxiliary modules, god-object `browser-control-port.ts` |
| 3 | B | 17 | 13 | 17 | 18 | **65** | Disqualified from #1 — asserted `ISOLATED_AGENT_WORLD_ID = 999` (actual 1004) and carried harness contamination |
| 4 | D | 15 | 17 | 16 | 15 | **63** | Conditional — good diagrams; lower coverage; missed B21/B23 and hardcoded paths |
| 5 | E | 14 | 17 | 16 | 15 | **62** | Conditional — strongest single insight (sync `icacls` DACL spawns, main-thread JSON.parse/SHA-256 replay lag); lowest file count |

**Dispute resolution (verifier, re-confirmed by controller):** `ISOLATED_AGENT_WORLD_ID = 1004` (`src/main/browser/semantic-ref-types.ts:9`); 999 is the Electron preload world. Candidate B is wrong; A, C and E are correct.

**Finalizer applied:** scout does **not** select the winner's report. This document is the evidence-validated, deduplicated **union** across all five passes; paths that failed controller validation were dropped and corrected per §0.2.

**Confidence:** High for the file directory, line counts, constants, and bottleneck set (all independently re-verified on disk). Moderate for the flow narratives (derived from candidate synthesis plus spot-checked source anchors, not full control-flow tracing of every branch).
