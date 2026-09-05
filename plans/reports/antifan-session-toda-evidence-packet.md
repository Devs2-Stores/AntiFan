# Immutable Evidence Packet: AntiFan Browser Desktop Weakness Analysis (Session Toda)

## 1. Context & Scope
- **Target Application:** AntiFan Browser Desktop (Electron + MCP Companion for Theme & Web Application Engineering).
- **Target Session Log:** `<omp-sessions-dir>/--E--Work-customizes-Toda--/2026-09-05T05-05-10-088Z_01a06ff4-cfc8-709a-8baf-2d4d0e3cceb1.jsonl` (1,271 JSONL records, 716 messages, 9.46 MB).
- **Target Store:** Haravan Storefront (`https://<customer-storefront-domain>/`), customizing:
  - Google Sheets feedback review & data extraction across multiple tabs
  - Lead submission form (`assets/toda-leadform.js`)
  - Order sample page (`templates/page.about-03.liquid`)
  - 3D Online Catalogue section (`templates/page.toda-catalogue.liquid`, `assets/toda-catalogue.css`, `assets/toda-catalogue.js`)
  - Theme customization instructions (`config/settings.html`)
- **Workstation Environment:** Windows 11 Pro, running active `hrv theme dev` watcher.

---

## 2. Quantitative Tool Usage & Behavioral Telemetry
- **Total Tool Invocations:** 533 calls
  - `write` (including MCP tool invocations to `xd://mcp__antifan_browser_*`): 243 calls (45.6%)
  - `read` (including 48 schema discovery calls to `xd://mcp__antifan_browser_*`): 164 calls (30.8%)
  - `grep`: 51 calls (9.6%)
  - `todo`: 25 calls (4.7%)
  - `edit`: 21 calls (3.9%)
  - `bash`: 16 calls (3.0%)
  - `glob`: 8 calls (1.5%)
  - `eval`: 5 calls (0.9%)
- **AntiFan MCP Tool Usage Distribution (240 total calls):**
  - `anti.browser.evaluate`: **65 calls (27.1%)** — Still the primary fallback mechanism for reading state, scrolling, and querying geometry.
  - `anti.screenshot.viewport`: 19 calls (7.9%)
  - `anti.browser.tabs.create`: 14 calls (5.8%)
  - `anti.browser.reload`: 14 calls (5.8%)
  - `anti.inspect.responsive_matrix`: 13 calls (5.4%)
  - `anti.inspect.dom`: 12 calls (5.0%)
  - `anti.inspect.snapshot`: 9 calls (3.8%)
  - `report_issue`: **9 calls (3.8%)** — Agent explicitly filed 9 distinct bugs during work!
  - `anti.browser.tabs.close`: 9 calls (3.8%)
  - `anti.visual.compare`: **9 calls (3.8%)** — Multiple failures with `TARGET_STALE` & `TARGET_MISMATCH`.
  - `theme.qa_validate`: 8 calls (3.3%)
  - `anti.inspect.styles`: 8 calls (3.3%)
  - `anti.browser.tabs.list`: 7 calls (2.9%)
  - `browser_set_viewport`: 6 calls (2.5%)
  - `anti.trace.interaction`: 5 calls (2.1%)
- **Verified Tool Failure Breakdown:**
  - **Genuine AntiFan MCP Failures (21 errors):**
    - `anti.visual.compare`: 9 errors (repeated `TARGET_STALE: Failed to capture non-empty viewport screenshot`, 10s CDP timeout, `TARGET_MISMATCH`, missing artifact)
    - `theme.qa_validate`: 3 errors (`TARGET_MISMATCH: Tab ID mismatch`)
    - `anti.browser.evaluate`: 3 errors (fetch error, 15s evaluation timeout on background tab, object error)
    - `anti.verification.record_claim`: 2 errors (`INVALID_ARGUMENT: Obligation must have a non-empty metric string`)
    - `anti.trace.interaction` / `anti.agent.cursor.scroll`: 2 errors (`TARGET_STALE: document generation stale`)
    - `anti.browser.tabs.close`: 1 error (`TARGET_MISMATCH: Session isolated to primary tab`)
    - `anti.inspect.styles`: 1 error (`NODE_DETACHED`)
  - **Harness Artifact ID Incompatibility (2 errors):**
    - `read` / `grep` on `artifact://artifact-...` rejected with `artifact:// ID must be numeric`.
  - **Non-AntiFan Local Failures (10 errors):**
    - Git repository checks outside git root, `magick` binary missing, file path not found during creation.
  - `anti.inspect.page_inventory`: 4 calls (1.7%)
  - `anti.media.freeze`: 4 calls (1.7%)
  - `anti.browser.tabs.activate`: 3 calls (1.3%)
  - `browser_press_key`: 3 calls (1.3%)
  - `anti.agent.cursor.type`: 2 calls (0.8%)
  - `anti.browser.navigate`: 2 calls (0.8%)
  - `anti.verification.record_claim`: 2 calls (0.8%)
  - `anti.artifact.read`: 1 call (0.4%)
  - `theme.assert_cart`: 1 call (0.4%)
  - `anti.theme.resolve_element`: 1 call (0.4%)
  - `anti.inspect.region`: 1 call (0.4%)

---

## 3. Eight Concrete Empirical Weaknesses & Verified Root Causes

### Weakness 1: Cross-Tab Screenshot Bleed (Target Bleed on Background Tabs)
- **Empirical Telemetry:** In Record [32], `anti.screenshot.viewport` was called with `tabId: "08ce62f2-..."` (Google Sheets feedback tab), but returned a screenshot showing the active foreground storefront tab (`1b1fe78a-...`).
- **Verified In-Repo Gap:** In `src/main/browser/tab-devtools-host.ts:1042-1062`, Tier 2 CDP capture issues `Page.captureScreenshot({ fromSurface: true })`. `fromSurface: true` directs Chromium to capture from the OS window compositor surface. When a tab is in the background (hidden or not the top view), the compositor surface contains the pixels of the *active foreground tab*, leaking foreground visual content into the background tab's capture.
- **Operational Impact:** Agent visually audited the wrong web page, causing the user to intervene in Record [106]: *"Sai nhé, nội dung đúng là tab 08ce62f2-64c7-408c-a91e-e992aae7095a"*.

### Weakness 2: Visual Compare Failure on Background/Reference Tabs
- **Empirical Telemetry:** In Records [186], [248], [293], [329], [340], [790], [1184], `anti.visual.compare` failed repeatedly with:
  - `TARGET_STALE: Failed to capture non-empty viewport screenshot on tab... (document may still be rendering)`
  - `CAPABILITY_ERROR: CDP command Page.captureScreenshot timed out after 10000ms`
  - `TARGET_MISMATCH`
- **Verified In-Repo Gap:** In `src/main/tools/browser-control-port.ts:2357-2364` and `2410-2417`, `visualCompare()` takes screenshots of both the current tab and `comparisonTabId` via `this.host.captureScreenshot(undefined, ...)`. If either tab is a background tab, `captureScreenshot` returns empty or times out in CDP. Additionally, `visualCompare()` ignores `clipRect` or `selector` during capture, passing `undefined` as `rect` into `captureScreenshot`, forcing full viewport capture.
- **Operational Impact:** Despite the user explicitly requesting in Record [975]: *"Chỗ Online Catalogue làm y chang dùm, áp Visual Compare"*, the tool repeatedly failed, forcing the agent to abandon visual compare and fall back to manual inspection.

### Weakness 3: Monolithic Session Tab Locking & Overly Aggressive `TARGET_MISMATCH`
- **Empirical Telemetry:** In Records [134] and [142], calling `anti.browser.tabs.close` and `theme.qa_validate` threw:
  - `TARGET_MISMATCH: Cannot close tab "...". This session is isolated to tab "08ce62f2-..." and its managed tabs.`
  - `TARGET_MISMATCH: Tab ID mismatch: expected 08ce62f2-..., got 1b1fe78a-...`
- **Verified In-Repo Gap:** In `browser-capabilities.ts:1168-1170` and `browser-control-port.ts:941-943, 2874-2878`, the control plane strictly restricts operations to `context.browserTarget.tabId` (a single bound tab). Legitimate multi-tab workflows (e.g. Reference sheet + Storefront + Product + Catalogue) are blocked from closing or validating secondary tabs unless the agent explicitly rebinds the target.
- **Operational Impact:** The agent is paralyzed when coordinating tasks across multiple tabs, unable to close auxiliary tabs or run validation on the actual theme page.

### Weakness 4: Target Metadata Inconsistency in Compound Tools
- **Empirical Telemetry:** In Record [689], agent reported: `theme.debug_bundle: calls with explicit product/order tabId returned the requested page hierarchy but target.tabId incorrectly reported the current policy tab ID 8712ef0d-...; target metadata is inconsistent with payload.`
- **Verified In-Repo Gap:** In `src/main/tools/browser-capabilities.ts:1316, 1338`, `theme.debug_bundle` receives `params.tabId` and passes it to internal probes (`dom`, `eval`), but returns `{ target, ... }` where `target` is the unchanged `context.browserTarget` object.
- **Operational Impact:** Downstream consumers and agents receive discordant telemetry where payload data comes from tab B, but target metadata asserts it came from tab A.

### Weakness 5: Schema Drift in `proofObligations` (`anti.verification.record_claim`)
- **Empirical Telemetry:** In Record [790], agent reported: `anti.verification.record_claim: documented proofObligations schema is untyped {}, but valid-looking obligations are rejected because undocumented required field metric must be non-empty.`
- **Verified In-Repo Gap:** In `scripts/antifan-omp-mcp.cjs:55`, `proofObligations` was exported as `{ type: 'array', items: { type: 'object' } }` without specifying required fields. In `src/main/tools/browser-capabilities.ts:2546-2548`, the backend strictly enforces `if (!obl || typeof obl.metric !== 'string' || !obl.metric.trim()) throw new CapabilityError('INVALID_ARGUMENT', ...)`!
- **Operational Impact:** The agent crafted valid-looking objects according to the published tool schema, but every submission was rejected by the backend validator.

### Weakness 6: Harness Artifact URI Incompatibility
- **Empirical Telemetry:** In Records [32] and [66], the agent attempted to read artifact references:
  `read(path="artifact://artifact-586415ab-7d50-4b01-a79b-f54b431a56bb")` $\rightarrow$ `Error: artifact:// ID must be numeric, got: artifact-586415ab-7d50-4b01-a79b-f54b431a56bb`.
- **Verified In-Repo Gap:** The Oh My Pi harness's built-in `artifact://` URI scheme strictly validates numeric integer IDs (e.g. `artifact://62`), whereas AntiFan's `ArtifactStore` mints UUID-based string identifiers (`artifact-<uuid>`).
- **Operational Impact:** Standard agent tools (`read`, `grep`) fail immediately when accessing AntiFan artifacts, forcing the agent into expensive, paginated 32KB frame reads via `anti.artifact.read`.

### Weakness 7: Concurrency & Lock Collisions in `eval / tool.write` Aggregation
- **Empirical Telemetry:** In Record [648], the agent attempted to audit 8 routes in parallel inside `eval` (`Promise.all` calling `tool.write` for `responsive_matrix`, `theme_debug_bundle`, `page_inventory`). All routes returned empty/zero results, prompting Record [651]: `eval/tool.write aggregation: direct AntiFan MCP calls return populated JSON, but the same calls through eval tool.write returned values that parsed into all-zero/false summaries...`
- **Verified In-Repo Gap:** AntiFan's execution engine utilizes shared locks (`this.viewportGate.withLock`, `this.passivePool.execute`). When 24 asynchronous tool invocations hit the bridge concurrently without target re-negotiation, lock contention and tab lease checks cause executions to fail or return default fallbacks.
- **Operational Impact:** Prevents agents from running fast parallel audits across storefront routes.

### Weakness 8: High-Level Primitive Gap (65 Raw `anti_browser_evaluate` Calls)
- **Empirical Telemetry:** The agent executed 65 raw JavaScript evaluations for routine operations:
  - Reading `window.scrollX`, `window.scrollY`, `window.innerWidth`, `window.innerHeight`, `devicePixelRatio`
  - Deterministic scrolling (`window.scrollTo(0, 500)`)
  - Measuring bounding rects of specific elements (`.getBoundingClientRect()`)
  - Checking `document.readyState`
- **Verified In-Repo Gap:** AntiFan provides `anti_agent_cursor_scroll` (simulated mouse scrolling via deltaY), but lacks a deterministic scroll/anchor tool and lightweight geometry probe tool. Agents are forced to write multi-line JavaScript snippets to obtain basic layout facts.
