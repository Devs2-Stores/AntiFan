# Immutable Evidence Packet: AntiFan Browser Desktop Weakness Analysis (Session Tototuantu)

## 1. Context & Scope
- **Target App:** AntiFan Browser Desktop (Electron + MCP Companion for Theme & Web Application Engineering).
- **Target Session Log:** `C:/Users/Admin/.omp/agent/sessions/--E--Work-customizes-Tototuantu--/2026-09-05T04-42-44-030Z_01a06fe0-45be-70f8-bad9-ae99b06187a1.jsonl` (429 JSONL records, 281 messages, ~1MB).
- **Target Store:** Haravan Storefront (`https://tototuantu.vn/`), customizing sticky header and breadcrumb navigation across Homepage, Collection, and Product pages.
- **Workstation Environment:** Windows 11 Pro, running active `hrv theme dev` watcher in an external terminal.

---

## 2. Quantitative Tool Usage & Behavioral Telemetry
- **Total Tool Calls in Session:**
  - `write` (including MCP tool invocations to `xd://mcp__antifan_browser_*`): 52 calls
  - `read` (including 9 schema discovery calls to `xd://mcp__antifan_browser_*`): 45 calls
  - `grep`: 13 calls, `glob`: 12 calls, `todo`: 10 calls, `edit`: 5 calls, `bash`: 1 call
- **AntiFan MCP Tool Usage Distribution:**
  - `anti.browser.evaluate`: 26 calls (65% of all AntiFan runtime interactions!)
  - `anti.browser.navigate`: 6 calls
  - `browser_set_viewport`: 4 calls
  - `anti.screenshot.viewport`: 2 calls (both returned empty/broken)
  - `anti.browser.tabs.create`: 1 call
  - `anti.browser.tabs.list`: 1 call (returned `[]`)
  - `anti.browser.tabs.close`: 1 call
  - `anti.browser.reload`: 1 call (triggered URL reset)
  - `anti.inspect.styles`: 2 calls
  - `anti.inspect.responsive_matrix`: 1 call
  - Specialized domain tools (`theme.qa_validate`, `theme.debug_bundle`, `theme.assert_cart`, `storefront.resolve_product`, `anti.agent.cursor.*`, `anti.visual.compare`): **0 calls** (completely bypassed/irrelevant for layout & sticky engineering).

---

## 3. Six Concrete Empirical Weaknesses & Architectural Root Causes

### Weakness 1: Screenshot Capture Succeeds with an Empty Image
- **Empirical Telemetry:**
  - Call [219] (`format: png`, `tabId: 8114c9e7...`) returned MCP image content with `data: ""` and `mimeType: "image/png"`.
  - Call [222] (`format: jpeg`, `quality: 80`) returned the same empty image payload with `mimeType: "image/jpeg"`.
  - The client-side bridge did resolve the result as image content; therefore the earlier claim that `mcp-server.ts` failed to map an `ArtifactRef` to MCP `ImageContent` was contradicted by the session record.
- **Verified In-Repo Gap:**
  - `TabDevToolsHost.captureScreenshot()` can return `''` for a missing target/WebContents or after every capture tier and retry fails (`src/main/browser/tab-devtools-host.ts:900-905,1083-1092`).
  - `BrowserControlPort.screenshot()` decodes and stages that empty string without a non-empty guard (`src/main/tools/browser-control-port.ts:668-675`). `ArtifactStore.stage()` accepts the resulting zero-byte buffer as a valid artifact (`src/main/tools/artifact-store.ts:124-163`).
  - The secure OMP bridge already resolves image artifacts to standard MCP image content (`scripts/antifan-omp-mcp.cjs:547-569`); the missing guard lets a zero-byte artifact flow through that valid resolver.
- **Operational Impact:** Visual verification failed, and the agent had to rely on JavaScript geometry probes.


### Weakness 2: Viewport Setter Reports Success Without Verifying the Target Renderer
- **Empirical Telemetry:**
  - Calls [243], [313], and [322] reported the requested viewport, including mobile `375x812`.
  - Calls [238], [320], and [326] subsequently observed `window.innerWidth === 1920`; desktop media-query behavior remained active.
- **Verified In-Repo Gap:**
  - `setViewportSize()` records `customViewport`, invokes `updateLayout()`, waits for touch emulation, and returns `true` without reading the renderer's effective viewport (`src/main/browser/native-tab-host.ts:5478-5496`).
  - `updateLayout()` applies device emulation only to `activeTabId` (`src/main/browser/native-tab-host.ts:764-790`), while `setViewportSize()` accepts a distinct explicit `tabId`. A background target can therefore receive state but not the layout application.
  - For the active single-view path, `updateLayout()` does call Electron `webContents.enableDeviceEmulation()` indirectly through `safeEnableDeviceEmulation()` (`src/main/browser/native-tab-host.ts:3982-4012,514-527`). The earlier assertion that this path never applies device metrics was incorrect.
  - **[INFERENCE]** The active-tab/explicit-target split is a plausible cause of this session's `1920px` observation, but the exact runtime cause still requires a real-Chromium reproduction.
- **Operational Impact:** A false-success response allowed invalid responsive evidence.


### Weakness 3: Reload Returns Before Completion; the Observed Homepage Redirect Is Unexplained
- **Empirical Telemetry:**
  - The tab had previously visited `/collections/bo-sen-am-tuong-2-duong-ra` at call [269].
  - Call [380] returned `reloaded: true`; later call [386] observed `https://tototuantu.vn/`, and the agent re-navigated at [389].
- **Verified In-Repo Gap:**
  - `BrowserControlPort.reload()` calls the fire-and-forget host `reload()` and immediately reports success (`src/main/tools/browser-control-port.ts:581-586`).
  - `NativeTabHost.reloadAndWait()` already provides load completion and network-quiescence semantics but is unused by that public capability (`src/main/browser/native-tab-host.ts:3518-3568`).
  - `webContents.reload()` normally reloads the current URL; it does not itself prove why this storefront ended at the homepage. **[INFERENCE]** A race, redirect, earlier navigation state, or storefront behavior caused the URL change. The session does not isolate which mechanism.
- **Operational Impact:** The caller receives a success acknowledgement before it is safe to inspect the resulting document.


### Weakness 4: Theme Preview Workflow Lacked a Safe Mutation Boundary
- **Empirical Telemetry:**
  - The user had `hrv theme dev` active; a local edit to `assets/main.css` was therefore synchronized by the external watcher.
  - User turns [373], [375], and [395] show that the agent did not account for this environment before moving from in-memory testing to disk mutation.
  - In-memory CSS injection through `anti.browser.evaluate` had already provided a non-destructive test path.
- **Classification:** This is primarily a workflow and agent-safety failure, not proof that AntiFan requires a CDN interception proxy. A duplicate draft theme or an in-memory style override provides a smaller safety boundary. A CDP `Fetch` proxy would add cache, service-worker, and server-rendered-markup mismatch risks.
- **Operational Impact:** The test/apply boundary was ambiguous, allowing a local test edit to become a live storefront change.


### Weakness 5: Tool Discovery and Target/Pan​e Guidance Caused Avoidable Round-Trips
- **Empirical Telemetry:**
  - The agent used nine separate schema reads before invoking AntiFan tools.
  - `anti.browser.tabs.list` initially returned `[]`; the agent then created a background tab and later operated on it by explicit `tabId`.
- **Operational Impact:** Extra latency and context consumption. The stronger product opportunity is better capability discovery and target/pane guidance, not automatic adoption of arbitrary user tabs.

### Weakness 6: Raw `evaluate` Was Effective but Repetitive
- **Empirical Telemetry:**
  - 26 of 40 AntiFan interactions were `anti.browser.evaluate` calls for scrolling, computed styles, geometry, and temporary CSS.
  - These calls completed the investigation, so high usage is not itself evidence of architectural failure.
- **Product Opportunity:** After core correctness is restored, a small idempotent in-memory CSS preview capability could standardize apply/replace/clear behavior and cleanup. A large sticky/layout-specific tool suite is not justified by this single session.


---

## 4. Evaluation Status
The planned five-candidate `--ultra` fan-out did not execute: all five subagents failed during startup with the same runtime `getWorkPoolYieldItems` error. No candidate was usable, no verifier ranking occurred, and no ultra winner exists. The corrected packet above is controller-grounded evidence, not an ultra-selected result.
