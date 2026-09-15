#!/usr/bin/env node
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const http = require('node:http');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List tabs in the live AntiFan Desktop Browser GUI (every tab in the window by default; pass all: false to list only the tabs this session owns). Primary browser tool for theme development and live tab management.', { all: { type: 'boolean', default: true, description: 'List every tab in the browser window (default). Pass false to restrict the list to the tabs this session owns.' } }],
  ['anti.browser.tabs.create', 'Open a new tab in live AntiFan Desktop Browser GUI without stealing focus by default.', { url: { type: 'string' }, activate: { type: 'boolean' } }],
  ['anti.browser.tabs.activate', 'Switch the active tab visible to the user in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.tabs.close', 'Close a tab in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.rebind_target', 'Rebind this session attachment to a live tabId after the bound tab detached or died. Use tabs.list to find a live tab, then rebind; subsequent calls target that tab.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.set_automation_target', 'Set the primary automation target tab for this session (authority rotation via CAS).', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.navigate', 'Navigate active or background tab in live AntiFan Desktop Browser GUI.', { url: { type: 'string' }, tabId: { type: 'string' } }, ['url']],
  ['anti.browser.reload', 'Reload active or background tab in live AntiFan Desktop Browser GUI.', { tabId: { type: 'string' } }],
  ['anti.inspect.dom', 'Read DOM elements and computed attributes from AntiFan Desktop tab (supports desktop and mobile split panes). Operates directly against background tab.', { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.screenshot.viewport', 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes, format: jpeg/png). Viewport-only: full_page:true is rejected; use anti.screenshot.full_page for entire document height.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['jpeg', 'png'] }, quality: { type: 'number' } }],
  ['anti.screenshot.full_page', 'Capture canonical PNG full-page evidence (entire document scroll height) and stage it under the evidence lease.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png'] }, quality: { type: 'number' }, leaseToken: { type: 'string' }, expectedUrl: { type: 'string' } }],
  ['anti.reference.capture', 'Capture a reference from a live page: materialize lazily-mounted content, settle, then stage the settled DOM (and optionally a screenshot) so later measurements describe the page a comparator actually rasterizes.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, screenshot: { type: 'boolean' }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' } }],
  ['anti.browser.set_viewport', 'Set the bound tab viewport dimensions and device emulation, verified against the size the tab actually measures.', { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, ['width', 'height']],
  ['anti.browser.get_viewport', 'Get the bound tab viewport dimensions, DPR, device preset, and layout surface state without applying overrides.', { tabId: { type: 'string' } }],
  ['anti.agent.cursor.click', 'Move visual Agent Cursor and click an element in live AntiFan Desktop tab without stealing visual focus.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.move', 'Move visible Agent Cursor without clicking in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.type', 'Move visual Agent Cursor and type into an input element in live AntiFan Desktop tab without stealing visual focus.', { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['text']],
  ['anti.agent.cursor.scroll', 'Scroll active or background tab using visual Agent Cursor in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, deltaY: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.hover', 'Move visual Agent Cursor to hover over an element in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered or endlessly animating target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.highlight', 'Highlight a DOM element with visual Agent Cursor overlay in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.clear', 'Clear all active Agent Cursor overlays in live AntiFan Desktop tab.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['browser_find', 'Search the accessibility snapshot of the current page for text, pattern, query, or a regular expression.', { text: { type: 'string' }, pattern: { type: 'string' }, query: { type: 'string' }, regex: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['browser_press_key', 'Send native keyboard key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Control+a) to the active tab', { key: { type: 'string' }, tabId: { type: 'string' } }, ['key']],
  // Tier-2 device surface: the physical phone, driven directly over WebDriverAgent. These rows are
  // advertised under their catalogue names, so dispatch is unchanged and no routing row is needed.
  ['device.list', 'List iOS devices attached to this host (live enumeration over the USB multiplexer). Tier-2 surface: the real phone, not a Chromium pane.', {}],
  ['device.status', 'Read physical device readiness gates (attachment, trust, Developer Mode, UI Automation, WebDriverAgent) plus the current device binding. Reports absence honestly instead of failing, so "not set up" is never mistaken for "broken".', { deviceId: { type: 'string', description: 'Device UDID; omit when exactly one device is attached' } }],
  ['device.open_safari', 'Establish the Safari automation surface on the device (ensure the WebDriverAgent session) and return the bound device target, optionally deep-linking to a url.', { deviceId: { type: 'string', description: 'Device UDID; omit when exactly one device is attached' }, url: { type: 'string', description: 'Optional url to open on the device (deep-link; no load wait)' } }],
  ['device.navigate', 'Open a url in Safari on the real device. This is a deep-link: it returns immediately and never waits for load, so follow it with device.wait when a settled page matters.', { url: { type: 'string' } }, ['url']],
  ['device.reload', 'Re-open the last url this surface navigated to. WebDriverAgent exposes no refresh route and no URL readback, so reload is refused when no url is remembered.', {}],
  ['device.screenshot', 'Capture real-device screenshot evidence (the actual panel pixels a human would see) into the artifact store as a Tier-2 receipt.', {}],
  ['device.tap', 'Tap a point on the device panel. Coordinates are CSS points (the device viewport space), not raw pixels.', { x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']],
  ['device.swipe', 'Swipe on the device panel with a native gesture; momentum scrolling is produced by the device and nothing is emulated.', { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, durationMs: { type: 'number' } }, ['x1', 'y1', 'x2', 'y2']],
  ['device.type', 'Type text through the native keyboard into the currently focused field (tap the input first; WebDriverAgent types into the active element).', { text: { type: 'string' } }, ['text']],
  ['device.wait', "Wait on the real device: 'timeout' sleeps; 'page_loaded'/'stable' sample frames until rendering stops changing. That is a rendering heuristic, not a load or network-idle guarantee.", { type: { type: 'string', enum: ['timeout', 'page_loaded', 'stable'] }, value: { type: 'number', description: "Milliseconds for type 'timeout'" }, timeoutMs: { type: 'number' } }, ['type']],
  ['theme.qa_validate', 'Run the authoritative Theme QA verification workflow for the bound storefront tab and workspace.', { tabId: { type: 'string' }, workspaceRoot: { type: 'string' } }],
  ['theme.debug_bundle', 'Return an atomic storefront diagnostic bundle with platform, Liquid, overflow, and HS findings.', { tabId: { type: 'string' } }],
  ['theme.assert_cart', 'Inspect passive storefront cart contract telemetry without adding synthetic items.', { tabId: { type: 'string' } }],
  ['theme.resolve_product', 'Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability.', { handle: { type: 'string' }, tabId: { type: 'string' } }],
  ['storefront.resolve_product', 'Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability.', { handle: { type: 'string' }, tabId: { type: 'string' } }],
  ['anti.theme.style_override', 'In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers).', { operation: { type: 'string', enum: ['apply', 'clear'] }, id: { type: 'string' }, css: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['operation', 'id']],
  ['theme.style_override', 'In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers).', { operation: { type: 'string', enum: ['apply', 'clear'] }, id: { type: 'string' }, css: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['operation', 'id']],
  ['anti.agent.file_upload', 'Upload local files into a file input element in live AntiFan Desktop tab without native file dialogs.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.agent.drop', 'Dispatch native drag and drop file transfer onto a target drop zone element in live AntiFan Desktop tab.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.agent.drag', 'Drag a control (price slider, range handle, drag-to-reorder row) from one element/coordinate to another with a bounded interpolated pointer gesture. A press-and-release at the destination alone does not move a slider library.', { fromRef: { type: 'string', description: 'Origin semantic ref (@e1) from a snapshot' }, fromSelector: { type: 'string', description: 'Origin CSS selector' }, fromX: { type: 'number' }, fromY: { type: 'number' }, toRef: { type: 'string', description: 'Destination semantic ref (@e1)' }, toSelector: { type: 'string', description: 'Destination CSS selector' }, toX: { type: 'number' }, toY: { type: 'number' }, steps: { type: 'number', description: 'Interpolated pointer-move steps, clamped to 4..20 (default 10)' }, force: { type: 'boolean', description: 'Skip the occlusion and animation-stability gates for a knowingly covered target' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.snapshot', 'Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references (supports selector and viewportOnly filtering).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } }],
  ['anti.browser.evaluate', 'Execute JavaScript expression in page context with depth-capped circular protection. Refuses a tab with no laid-out surface (0x0 CSS px) unless allowDegradedSurface is set.', { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch; the page is not laid out and most measurements will be meaningless)' } }, ['expression']],
  ['anti.browser.evaluate_frame', 'Execute JavaScript inside a child frame selected by frameUrl substring.', { expression: { type: 'string' }, frameUrl: { type: 'string', minLength: 1 }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['expression', 'frameUrl']],
  ['anti.telemetry.record_fallback', 'Record sanitized fallback telemetry when invoking Playwright after an AntiFan capability failure.', { primaryTool: { type: 'string' }, fallbackTool: { type: 'string' }, fallbackResult: { type: 'string', enum: ['SUCCESS', 'FAILED', 'SKIPPED'] }, sessionId: { type: 'string' }, targetUrl: { type: 'string' }, errorCode: { type: 'string' }, errorMessage: { type: 'string' }, durationMs: { type: 'number' }, notes: { type: 'string' } }, ['primaryTool', 'fallbackTool', 'fallbackResult']],
  ['anti.inspect.styles', 'Inspect computed CSS styles, box model, typography, layout, and CSS variables for an element (supports @ref or CSS selector).', { selector: { type: 'string' }, ref: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.region', 'Inspect spatial region bounds, collecting intersecting visible DOM elements with coordinates and z-index.', { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.trace.interaction', 'Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout shifts.', { action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] }, selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, deltaY: { type: 'number' }, settleMs: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['action']],
  ['anti.visual.compare', 'Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking, and configurable tolerance.', { baselineScreenshotRef: { type: 'string' }, baselineRef: { type: 'string' }, comparisonTabId: { type: 'string' }, tolerance: { type: 'number' }, selector: { type: 'string' }, clipRect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } }, maskSelectors: { type: 'array', items: { type: 'string' } }, maskOptionalSelectors: { type: 'array', items: { type: 'string' } }, normalizeScroll: { type: 'boolean' }, fullPage: { type: 'boolean', description: 'Capture and compare entire document scroll height' }, useDefaultWidgetMasks: { type: 'boolean' }, leaseToken: { type: 'string' }, trackedSelectors: { type: 'array', items: { type: 'string' } }, heightTolerance: { type: 'number' }, allowHeightDrift: { type: 'boolean' }, maxGeometryDeltaPx: { type: 'number' }, expectedUrl: { type: 'string' }, expectedTargetUrl: { type: 'string' }, expectedBaselineUrl: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.media.freeze', 'Freeze or unfreeze dynamic media (videos, audios, CSS animations) in tab to enable deterministic visual comparisons. Native requestAnimationFrame scheduling is left untouched, so RAF-driven motion requires the settle barrier instead.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, freeze: { type: 'boolean', description: 'True to freeze media and pause animations; false to resume' } }],
  ['anti.inspect.page_inventory', 'Scan entire physical page structure from y=0 to scrollHeight, returning list of all sections, coordinates, heights, and layout groups (chống sót header/footer/newsletter).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.style_diff', 'Compare computed CSS styles and box-model metrics between elements on two tabs (or two selectors).', { selector: { type: 'string', description: 'CSS selector of target element on tab 1' }, comparisonSelector: { type: 'string', description: 'CSS selector on tab 2 (defaults to selector)' }, tabId: { type: 'string' }, comparisonTabId: { type: 'string' }, properties: { type: 'array', items: { type: 'string' }, description: 'CSS properties to compare' } }, ['selector']],
  ['anti.spec.validate_gate', 'Validate HTML Specification against target page to certify HTML_SPEC_READY status before theme compilation.', { specTabId: { type: 'string' }, targetTabId: { type: 'string' }, tolerance: { type: 'number' } }],
  ['anti.agent.sequence', 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards.', { actions: { type: 'array', items: { type: 'object' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, stopOnError: { type: 'boolean' } }, ['actions']],
  ['anti.artifact.read', 'Read an authorized artifact by ID with bounded chunk size (clamped to max 32KB per frame).', { artifactId: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['artifactId']],
  ['anti.artifact.stat', 'Retrieve metadata and size information for an authorized artifact.', { artifactId: { type: 'string' } }, ['artifactId']],
  ['browser.set-viewport', 'Set the bound Chromium tab viewport dimensions and device emulation.', { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, ['width', 'height']],
  ['browser.get-viewport', 'Get the bound Chromium tab viewport dimensions, DPR, device preset, and layout surface state without applying overrides.', { tabId: { type: 'string' } }],
  ['file.read', 'Read a file relative to the authoritative workspace root.', { path: { type: 'string' }, maxBytes: { type: 'number' } }, ['path']],
  ['file.write', 'Write a file relative to the authoritative workspace root with boundary enforcement.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['anti.theme.resolve_element', 'Map a live DOM element to bounded, correlated local theme source candidates.', { selector: { type: 'string' }, ref: { type: 'string' }, workspaceRoot: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.matched_styles', 'Inspect live CDP matched CSS and classify active versus overridden declarations.', { nodeId: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, stylesheetUrlMap: { type: 'object' } }],
  ['anti.inspect.responsive_matrix', 'Probe document and target overflow at the five standard responsive widths.', { selector: { type: 'string' }, tabId: { type: 'string' } }],
  ['anti.verification.record_claim', 'Record a live verification claim as UNVERIFIED with explicit proof obligations.', { claim: { type: 'string' }, category: { type: 'string', enum: ['INTERACTION', 'LAYOUT', 'RESPONSIVE', 'CUSTOM', 'VISUAL'] }, actor: { type: 'string', enum: ['agent', 'user'] }, tabId: { type: 'string' }, selector: { type: 'string' }, expectedHeight: { type: 'number' }, expectedSections: { type: 'number' }, tolerance: { type: 'number' }, proofObligations: { type: 'array', maxItems: 50, items: { type: 'object', properties: { id: { type: 'string' }, metric: { type: 'string', description: 'Obligation metric identifier (required)' }, tolerance: { type: 'number' }, critical: { type: 'boolean' }, expected: {} }, required: ['metric'] } }, linkedIssueId: { type: 'string' } }, ['claim', 'tabId', 'category']],
  ['anti.verification.verify_claim', 'Evaluate a recorded claim against fresh live browser evidence and persist an authoritative receipt.', { claimId: { type: 'string' }, witnessObservation: { type: 'string' }, semanticFailureObservation: { type: 'string' } }, ['claimId']],
  ['anti.theme.export_clean', 'Materialize, sanitize (Livewire/SSR blobs and unhydrated modals stripped), and export clean static theme HTML directly to workspace file.', { outputPath: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, clean: { type: 'boolean', default: true }, materialize: { type: 'boolean', default: true } }, ['outputPath']],
  ['anti.browser.dump_dom', 'Stream clean or raw page DOM directly to a workspace file with zero MCP transport truncation and Windows-safe atomic writes.', { outputPath: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, clean: { type: 'boolean', default: true }, materialize: { type: 'boolean', default: true } }, ['outputPath']],
  ['anti.verification.list', 'List recorded verification claims and their current verdicts.', { verdict: { type: 'string', enum: ['VERIFIED', 'PARTIAL', 'REJECTED', 'INCONCLUSIVE', 'UNVERIFIED'] }, actor: { type: 'string', enum: ['agent', 'user'] }, tabId: { type: 'string' }, stalemateState: { type: 'string', enum: ['ACTIVE', 'STALEMATE', 'EXEMPTION_WAIVED'] }, limit: { type: 'number' } }],
  ['core.query', 'Query the local Super Core evidence store: anchored claims filtered by text/platform/unit/kind.', { text: { type: 'string' }, platform: { type: 'string' }, unitId: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } }],
  ['core.context_pack', 'Build a Context Pack for a task: relevant claims, unresolved conflicts, unknowns, permission scope.', { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } }, ['task']],
  ['core.recommend', 'Recommend from evidence: Context Pack + recommendation or explicit abstention.', { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } } }, ['task']],
  ['core.receipt', 'Issue a Decision Receipt binding task context and evidence revisions. Refused when Core unavailable.', { task: { type: 'string' }, packId: { type: 'string' }, recommendation: { type: 'string' }, abstained: { type: 'boolean' } }, ['task', 'recommendation']],
  ['core.ingest_outcome', 'Ingest a verified outcome as a case + pending candidate (never auto-promoted).', { task: { type: 'string' }, context: { type: 'string' }, outcome: { type: 'string' }, verificationRef: { type: 'string' }, unitId: { type: 'string' } }, ['task', 'outcome']],
  ['core.adjudicate', 'Adjudicate a candidate (PROMOTE/REJECT/SUPERSEDE) with explicit authority. Refused when Core unavailable.', { candidateId: { type: 'string' }, decision: { type: 'string', enum: ['PROMOTE', 'REJECT', 'SUPERSEDE'] }, authority: { type: 'string' }, rationale: { type: 'string' }, scope: { type: 'string', enum: ['production', 'acceptance-test'] } }, ['candidateId', 'decision', 'authority']],
  ['core.stats', 'Return Super Core store counts for verification.', {}],
  ['core.domain', 'Return a domain view (units, claims, eligible skills, gaps) or insufficient-evidence.', { name: { type: 'string' } }, ['name']],
  ['core.invalidate', 'Mark claims stale when their source changed or was deleted.', { entryId: { type: 'string' }, path: { type: 'string' } }],
  ['core.revoke', 'Revoke claims derived from a restricted source (permission propagation).', { entryId: { type: 'string' }, path: { type: 'string' } }],
  ['core.snapshot', 'Create a release snapshot for regression/rollback.', { note: { type: 'string' } }],
  ['core.rollback', 'Restore claims/candidates to a release snapshot.', { releaseId: { type: 'string' } }, ['releaseId']],
  // v4: Experience Graph
  ['core.record_experience_node', 'Record an experience graph node (CLIENT_REQUEST, PROJECT, TASK, CONTEXT, DECISION, IMPLEMENTATION, ARTIFACT, VERIFICATION, PRODUCTION, FEEDBACK, LESSON).', { kind: { type: 'string' }, refId: { type: 'string' }, label: { type: 'string' }, context: { type: 'string' } }, ['kind']],
  ['core.record_experience_edge', 'Record an experience graph edge between two nodes.', { fromNodeId: { type: 'string' }, toNodeId: { type: 'string' }, kind: { type: 'string' }, evidence: { type: 'string' } }, ['fromNodeId', 'toNodeId', 'kind']],
  ['core.experience_chain', 'Traverse the experience graph from a node (BFS, depth-bounded).', { fromNodeId: { type: 'string' }, depth: { type: 'number' } }, ['fromNodeId']],
  // v4: Anti-Pattern Library
  ['core.record_anti_pattern', 'Record an anti-pattern: what not to do, symptoms, evidence, affected platform, replacement.', { name: { type: 'string' }, whatNotToDo: { type: 'string' }, symptoms: { type: 'string' }, evidence: { type: 'string' }, affectedPlatform: { type: 'string' }, replacement: { type: 'string' } }, ['name']],
  ['core.anti_patterns', 'List anti-patterns, optionally filtered by platform/status.', { platform: { type: 'string' }, status: { type: 'string' } }],
  // v4: Workaround Library
  ['core.record_workaround', 'Record a workaround: problem, condition, solution, reason, platform, version, evidence.', { problem: { type: 'string' }, condition: { type: 'string' }, solution: { type: 'string' }, reason: { type: 'string' }, platform: { type: 'string' }, version: { type: 'string' }, evidence: { type: 'string' } }, ['problem']],
  ['core.workarounds', 'List workarounds, optionally filtered by platform/stillValid.', { platform: { type: 'string' }, stillValid: { type: 'boolean' } }],
  // v4: Fix Patterns
  ['core.record_fix_pattern', 'Record a fix pattern: before, after, why, evidence, lesson.', { before: { type: 'string' }, after: { type: 'string' }, why: { type: 'string' }, evidence: { type: 'string' }, lesson: { type: 'string' } }],
  ['core.fix_patterns', 'List fix patterns.', { limit: { type: 'number' } }],
  // v4: Case-Based Reasoning
  ['core.find_similar', 'Find similar claims, cases, decisions, anti-patterns, workarounds, fix patterns for a task.', { task: { type: 'string' }, platform: { type: 'string' }, limit: { type: 'number' } }, ['task']],
  // v4: Uncertainty Engine
  ['core.classify_uncertainty', 'Classify uncertainty level for a claim or task.', { claimId: { type: 'string' }, task: { type: 'string' } }],
  // v4: Knowledge Decay
  ['core.decay_check', 'Check for stale/aging claims beyond a threshold.', { staleDays: { type: 'number' } }],
  // v4: Corpus Audit
  ['core.corpus_audit', 'Run a corpus completion audit and record the result.', {}],
  // v4: Phase Gates
  ['core.check_phase_gate', 'Check a phase gate (coverage, evidence, conflict, temporal, promotion, regression).', { phase: { type: 'string' }, gate: { type: 'string' } }, ['phase', 'gate']],
  ['core.resolve_conflict', 'Resolve or classify a conflict (GENERAL_RULE, CONTEXTUAL_RULE, LEGACY_RULE, EXCEPTION, CONFLICTED, UNRESOLVED).', { id: { type: 'string' }, classification: { type: 'string', enum: ['GENERAL_RULE', 'CONTEXTUAL_RULE', 'LEGACY_RULE', 'EXCEPTION', 'CONFLICTED', 'UNRESOLVED'] }, note: { type: 'string' }, resolved: { type: 'boolean' } }, ['id', 'classification']],
  // v4: Core Regression
  ['core.record_regression', 'Record a core regression run result.', { newKnowledge: { type: 'string' }, affectedRules: { type: 'array', items: { type: 'string' } }, affectedCases: { type: 'array', items: { type: 'string' } }, affectedRecommendations: { type: 'array', items: { type: 'string' } }, replayResult: { type: 'string', enum: ['PASS', 'FAIL'] } }, ['replayResult']],
  // v4: Principles
  ['core.record_principle', 'Record a personal engineering principle.', { statement: { type: 'string' }, source: { type: 'string' }, derivedFrom: { type: 'string' } }, ['statement']],
  ['core.principles', 'List principles.', { status: { type: 'string' } }],
  // v4: Hidden Requirements
  ['core.record_hidden_requirement', 'Record a hidden requirement inferred from a task.', { task: { type: 'string' }, explicitReq: { type: 'string' }, inferredReq: { type: 'string' }, likelihood: { type: 'string' }, evidence: { type: 'string' } }, ['task']],
  ['core.hidden_requirements', 'List hidden requirements.', { task: { type: 'string' } }],
  // v4: Commercial Intelligence
  ['core.record_commercial', 'Record commercial intelligence for a task type.', { taskType: { type: 'string' }, quote: { type: 'number' }, scope: { type: 'string' }, estimate: { type: 'number' }, actual: { type: 'number' }, risk: { type: 'string' }, revisionCount: { type: 'number' } }, ['taskType']],
  ['core.commercial_intel', 'List commercial intelligence records.', { taskType: { type: 'string' } }],
  // v4: Tool Intelligence
  ['core.record_tool', 'Record tool intelligence.', { name: { type: 'string' }, problemSolved: { type: 'string' }, workflowStage: { type: 'string' }, inputs: { type: 'string' }, outputs: { type: 'string' }, failureModes: { type: 'string' }, timeSaved: { type: 'number' }, maintenanceCost: { type: 'number' }, roi: { type: 'number' }, usageFrequency: { type: 'string' } }, ['name']],
  ['core.tool_intel', 'List tool intelligence records.', { status: { type: 'string' } }],
  // v4: Archetypes
  ['core.record_archetype', 'Record a project archetype.', { name: { type: 'string' }, platform: { type: 'string' }, maturityLevel: { type: 'number' }, evidence: { type: 'array', items: { type: 'string' } } }, ['name']],
  ['core.archetypes', 'List archetypes.', { platform: { type: 'string' } }],
  // v4: Platform Semantics
  ['core.record_platform_semantic', 'Record a platform semantic fact.', { platform: { type: 'string' }, semanticRole: { type: 'string' }, propertyName: { type: 'string' }, cssFact: { type: 'string' }, semanticTruth: { type: 'string' }, evidence: { type: 'string' } }, ['platform', 'semanticRole']],
  ['core.platform_semantics', 'List platform semantics.', { platform: { type: 'string' }, semanticRole: { type: 'string' } }],
  // v4: Practice Parity
  ['core.record_practice_parity', 'Record declared vs observed practice parity.', { practice: { type: 'string' }, declared: { type: 'string' }, observed: { type: 'string' }, gap: { type: 'string' }, evidence: { type: 'string' } }, ['practice']],
  ['core.practice_parity', 'List practice parity records.', { practice: { type: 'string' } }],
  // v4: Skill Genealogy
  ['core.record_skill_version', 'Record a skill version/failure/fix/production event.', { skillId: { type: 'string' }, version: { type: 'string' }, failure: { type: 'string' }, fix: { type: 'string' }, production: { type: 'string' } }, ['skillId']],
  ['core.skill_genealogy', 'List skill version history.', { skillId: { type: 'string' } }, ['skillId']],
  // v4: Enriched Context Pack & Receipt
  ['core.context_pack_v2', 'Build an enriched Context Pack: claims + rules + historical cases + pitfalls + workarounds + recommended pattern + uncertainty + confidence.', { task: { type: 'string' }, platform: { type: 'string' }, unitIds: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } }, ['task']],
  ['core.receipt_v2', 'Issue an enriched Decision Receipt: evidence revisions + why + historical cases + risks + alternatives + uncertainty + confidence.', { task: { type: 'string' }, packId: { type: 'string' }, recommendation: { type: 'string' }, abstained: { type: 'boolean' } }, ['task', 'recommendation']],
];

let currentAuthorityRevision = null;
let dynamicBootstrap = null;

function resolveBridgeCandidates() {
  // Fail-closed, bootstrap-only authority: the OMP proxy connects exclusively to
  // the explicit bridge endpoint supplied via environment. It MUST NOT discover
  // bridge credentials from disk — ambient endpoint discovery is the fail-open
  // vector dual-plane eliminates.
  const parsedBootstrap = (() => {
    if (process.env.ANTIFAN_MCP_BOOTSTRAP) {
      try {
        const b = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP);
        if (b && typeof b.port === 'number' && b.port > 0) return b;
      } catch {}
    }
    if (process.env.ANTIFAN_ATTACHMENT_SECRET) {
      const port = parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10);
      if (port > 0) {
        return {
          port,
          host: process.env.ANTIFAN_HOST || '127.0.0.1',
          token: process.env.ANTIFAN_ATTACHMENT_SECRET,
          secret: process.env.ANTIFAN_ATTACHMENT_SECRET,
          runId: process.env.ANTIFAN_RUN_ID,
          attemptId: process.env.ANTIFAN_ATTEMPT_ID,
          projectId: process.env.ANTIFAN_PROJECT_ID,
          workspaceId: process.env.ANTIFAN_WORKSPACE_ID,
        };
      }
    }
    return null;
  })();

  if (!parsedBootstrap) return [];

  const host = parsedBootstrap.host || '127.0.0.1';
  const port = parsedBootstrap.port;
  const token = parsedBootstrap.token || parsedBootstrap.secret || '';
  return [
    {
      source: 'env',
      host,
      port,
      token,
      secret: parsedBootstrap.secret || token,
      pid: parsedBootstrap.ownerPid,
      pidAlive: parsedBootstrap.ownerPid ? true : null,
      startedAt: 0,
      isDev: Boolean(parsedBootstrap.isDev),
    },
  ];
}

// Disk discovery is delegated to the launcher's single candidate authority; the
// proxy keeps no filesystem or credential-discovery logic of its own. Failover is
// enabled only for a terminal-scoped agent session, so an unattended or
// hand-invoked proxy stays bootstrap-only and fail-closed.
const { resolveBridgeCandidates: discoverLocalCandidates, compareCandidates: compareBridgeCandidates } = require('./antifan-agent.cjs');

function hasTerminalInstanceContext() {
  return Boolean(
    process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID ||
    process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID ||
    process.env.ANTIFAN_TERMINAL_SESSION_ID ||
    process.env.ANTIFAN_BRIDGE_PID
  );
}

function resolveFailoverCandidates() {
  const pinnedCandidates = resolveBridgeCandidates().map((c) => ({ ...c, pinned: true, provenance: 'env' }));
  const seen = new Set(pinnedCandidates.map((c) => `${c.host}:${c.port}`));
  const discovered = hasTerminalInstanceContext()
    ? discoverLocalCandidates().filter((c) => !seen.has(`${c.host}:${c.port}`))
    : [];
  // Single-instance invariant: the app exits on a second process, so the bridge
  // this session already bootstrapped against is always a legitimate failover
  // candidate — reconnecting to it reuses the existing secret, no disk discovery.
  const boot = getBootstrap();
  if (boot && boot.port && (boot.secret || boot.token)) {
    const key = `127.0.0.1:${boot.port}`;
    if (!seen.has(key)) {
      pinnedCandidates.push({ host: '127.0.0.1', port: boot.port, token: boot.token || boot.secret, pinned: true, provenance: 'bootstrap' });
    }
  }
  return [...pinnedCandidates, ...discovered].sort(compareBridgeCandidates);
}

function getBootstrap() {
  if (dynamicBootstrap && dynamicBootstrap.secret) {
    if (currentAuthorityRevision) {
      dynamicBootstrap.authorityRevision = currentAuthorityRevision;
    }
    return dynamicBootstrap;
  }
  if (process.env.ANTIFAN_MCP_BOOTSTRAP) {
    try {
      const b = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP);
      if (b.authorityRevision && !currentAuthorityRevision) {
        currentAuthorityRevision = b.authorityRevision;
      }
      return {
        ...b,
        tabId: process.env.ANTIFAN_BOUND_TAB_ID || b.tabId || undefined,
        authorityRevision: currentAuthorityRevision || b.authorityRevision,
        ownerPid: b.ownerPid || (process.env.ANTIFAN_OWNER_PID ? parseInt(process.env.ANTIFAN_OWNER_PID, 10) : undefined),
      };
    } catch {
      return null;
    }
  }
  if (process.env.ANTIFAN_ATTACHMENT_SECRET) {
    if (process.env.ANTIFAN_AUTHORITY_REVISION && !currentAuthorityRevision) {
      currentAuthorityRevision = process.env.ANTIFAN_AUTHORITY_REVISION;
    }
    return {
      port: parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10),
      secret: process.env.ANTIFAN_ATTACHMENT_SECRET,
      attachmentId: process.env.ANTIFAN_ATTACHMENT_ID,
      tabId: process.env.ANTIFAN_BOUND_TAB_ID || undefined,
      authorityRevision: currentAuthorityRevision || process.env.ANTIFAN_AUTHORITY_REVISION,
      runId: process.env.ANTIFAN_RUN_ID,
      attemptId: process.env.ANTIFAN_ATTEMPT_ID,
      projectId: process.env.ANTIFAN_PROJECT_ID,
      workspaceId: process.env.ANTIFAN_WORKSPACE_ID,
      ownerPid: process.env.ANTIFAN_OWNER_PID ? parseInt(process.env.ANTIFAN_OWNER_PID, 10) : undefined,
    };
  }
  return null;
}

// A 401 from /api/artifacts/* is an authority problem, never an artifact problem: the attachment
// secret this process holds was revoked because the host rotated its epoch (restart/autoheal) and
// the caller's `bootstrap` snapshot predates that rotation. Other statuses are the artifact's own
// answer and must not trigger a re-handshake.
const ARTIFACT_AUTH_FAILURE = /unauthorized|invalid or expired attachment secret|attachment_secret_required|inactive or expired attachment record/i;

/**
 * Fetch raw binary artifact bytes over HTTP from BridgeServer using single-header authentication.
 *
 * The authority may rotate mid-call (`ensureDispatchSocket` autoheals and replaces the process
 * bootstrap), which leaves the `bootstrap` passed in here stale. Without recovery the artifact read
 * fails with `Unauthorized: Invalid or expired attachment secret` for every screenshot/inspect
 * payload until the MCP process itself is restarted, even though the dispatch path already healed.
 * So on an auth-class failure, re-handshake once and retry with the authority the bridge hands back.
 */
async function fetchArtifactBinary(bootstrap, artifactId) {
  function fetchChunk(auth, offset = 0, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: auth.port,
        path: `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${limit}`,
        method: 'GET',
        headers: {
          'x-antifan-attachment-secret': auth.secret,
        },
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            let errMsg = `Artifact download failed with status ${res.statusCode}`;
            try {
              const errObj = JSON.parse(buffer.toString('utf8'));
              if (errObj && errObj.error) errMsg = errObj.error;
            } catch {}
            const err = new Error(JSON.stringify({ code: 'ARTIFACT_READ_ERROR', message: errMsg }));
            err.authFailure = res.statusCode === 401 || ARTIFACT_AUTH_FAILURE.test(errMsg);
            return reject(err);
          }
          const hasMore = res.headers['x-artifact-has-more'] === 'true';
          const totalBytes = parseInt(res.headers['x-artifact-total-bytes'] || '0', 10) || buffer.length;
          const mimeType = res.headers['content-type'] || 'image/png';
          resolve({
            buffer,
            hasMore,
            totalBytes,
            mimeType,
          });
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('ARTIFACT_STREAM_TIMEOUT'));
      });

      req.on('error', (err) => {
        reject(new Error(JSON.stringify({ code: 'ARTIFACT_FETCH_ERROR', message: `Artifact fetch failed: ${err.message}` })));
      });

      req.end();
    });
  }

  async function downloadAll(auth) {
    const collectedChunks = [];
    let currentOffset = 0;
    let finalMimeType = 'application/octet-stream';
    const CHUNK_SIZE = 1024 * 1024;

    while (true) {
      const chunkRes = await fetchChunk(auth, currentOffset, CHUNK_SIZE);
      collectedChunks.push(chunkRes.buffer);
      finalMimeType = chunkRes.mimeType;
      currentOffset += chunkRes.buffer.length;

      if (!chunkRes.hasMore || chunkRes.buffer.length === 0) {
        break;
      }
    }

    return {
      data: Buffer.concat(collectedChunks).toString('base64'),
      mimeType: finalMimeType,
    };
  }

  // Read with the authority THIS call dispatched under. Artifacts are run/attempt scoped
  // (the bridge answers ATTACHMENT_MISMATCH otherwise) and every autoheal mints a fresh
  // run/attempt pair, so a heal performed for some OTHER concurrent invocation must not be
  // preferred here: its authority would 403 against an artifact this call's stager wrote,
  // and a 403 is not an auth failure, so the recovery below would never run.
  try {
    return await downloadAll(bootstrap);
  } catch (err) {
    if (!err || !err.authFailure) throw err;
    process.stderr.write('[AntiFan MCP] Artifact read refused the held attachment secret; re-handshaking...\n');
    let refreshed = null;
    try {
      refreshed = await autohealSession();
    } catch (healErr) {
      process.stderr.write(`[AntiFan MCP] Artifact autoheal failed: ${healErr.message}\n`);
    }
    const authority = (refreshed && refreshed.secret) ? refreshed : getBootstrap();
    // Nothing new to present: surface the original refusal rather than replaying it.
    if (!authority || !authority.secret || authority.secret === bootstrap.secret) throw err;
    return await downloadAll(authority);
  }
}

// An advertised tool name is authoritative whenever the catalogue registers that
// same name: the capability is reached by dispatching it unchanged (`|| method`
// below). Only a genuine rename belongs here — a row whose target equals its key
// is a no-op that hides which registration actually executes, and a row that
// redirects a name the catalogue already owns silently swaps the server's
// semantics for the target's (anti.browser.tabs.list is window-wide by default;
// browser.list-tabs is session-scoped). `scripts/check-mcp-budget-dominance.mjs`
// fails the compile on a no-op row or on a target the catalogue does not
// register, and REPORTS every row that shadows a registration the catalogue
// already owns: those form the deferred routing sweep, each needing its own
// behaviour-preserving proof, and anti.browser.tabs.list was one instance.
const CAPABILITY_MAP = Object.freeze({
  'anti.browser.tabs.create': 'browser.open-tab',
  'anti.browser.tabs.activate': 'browser.switch-tab',
  'anti.browser.tabs.close': 'browser.close-tab',
  'anti.browser.rebind_target': 'browser.rebind-target',
  'anti.browser.set_automation_target': 'browser.set-automation-target',
  'anti.browser.navigate': 'browser.navigate',
  'anti.browser.reload': 'browser.reload',
  'anti.inspect.dom': 'browser.dom',
  'anti.browser.set_viewport': 'browser.set-viewport',
  'anti.browser.get_viewport': 'browser.get-viewport',
  'anti.agent.cursor.click': 'browser.agent-click',
  'anti.agent.cursor.move': 'browser.agent-move',
  'anti.agent.cursor.type': 'browser.agent-type',
  'anti.agent.cursor.scroll': 'browser.agent-scroll',
  'anti.agent.cursor.hover': 'browser.agent-hover',
  'anti.agent.cursor.highlight': 'browser.agent-highlight',
  'anti.agent.cursor.clear': 'browser.agent-clear',
  'anti.inspect.styles': 'browser.inspect_styles',
  'anti.inspect.region': 'browser.inspect_region',
  'anti.trace.interaction': 'browser.trace_interaction',
  'anti.inspect.page_inventory': 'browser.page-inventory',
  'anti.agent.sequence': 'browser.agent-sequence',
  'browser_find': 'browser.find',
  'anti.artifact.read': 'artifact.read',
  'artifact_read': 'artifact.read',
  'anti.artifact.stat': 'artifact.stat',
  'artifact_stat': 'artifact.stat',
  'anti.theme.export_clean': 'browser.dump_dom',
  'anti.browser.dump_dom': 'browser.dump_dom',
});

// ---------------------------------------------------------------------------
// Super Core: local evidence/provenance store (packages/super-core). These
// capabilities are handled in-process by invokeCore — they never reach the
// bridge dispatch socket. Unavailable Core returns {available:false} for
// advisory calls and refuses receipt-required actions.
let coreInstance = null;
function getCore() {
  if (coreInstance) return coreInstance;
  const dbPath = process.env.SUPER_CORE_DB
    || require('node:path').join(__dirname, '..', '.super-core', 'core.db');
  try {
    const { openCore } = require('../packages/super-core/dist/index.js');
    coreInstance = openCore(dbPath);
    return coreInstance;
  } catch (e) {
    return null;
  }
}
async function invokeCore(method, params) {
  const core = getCore();
  const mutating = new Set(['core.receipt','core.adjudicate','core.ingest_outcome','core.invalidate','core.revoke','core.snapshot','core.rollback']);
  if (!core) {
    if (mutating.has(method)) {
      throw new Error(JSON.stringify({ code: 'CORE_UNAVAILABLE', message: `Super Core store unavailable; mutating action ${method} refused` }));
    }
    return { available: false, reason: 'super-core package not built or db unreachable', method };
  }
  switch (method) {
    case 'core.query': return core.query(params);
    case 'core.context_pack': return core.contextPack(params);
    case 'core.recommend': return core.recommend(params);
    case 'core.receipt': return core.receipt(params);
    case 'core.ingest_outcome': return core.ingestOutcome(params);
    case 'core.adjudicate': return core.adjudicate(params);
    case 'core.stats': return core.stats();
    case 'core.domain': return core.domain(params.name);
    case 'core.invalidate': return core.invalidate(params);
    case 'core.revoke': return core.revoke(params);
    case 'core.snapshot': return core.snapshot(params.note);
    case 'core.rollback': return core.rollback(params.releaseId);
    // v4
    case 'core.record_experience_node': return core.recordExperienceNode(params);
    case 'core.record_experience_edge': return core.recordExperienceEdge(params);
    case 'core.experience_chain': return core.experienceChain(params.fromNodeId, params.depth);
    case 'core.record_anti_pattern': return core.recordAntiPattern(params);
    case 'core.anti_patterns': return core.antiPatterns(params);
    case 'core.record_workaround': return core.recordWorkaround(params);
    case 'core.workarounds': return core.workarounds(params);
    case 'core.record_fix_pattern': return core.recordFixPattern(params);
    case 'core.fix_patterns': return core.fixPatterns(params);
    case 'core.find_similar': return core.findSimilar(params);
    case 'core.classify_uncertainty': return core.classifyUncertainty(params);
    case 'core.decay_check': return core.decayCheck(params);
    case 'core.corpus_audit': return core.corpusAudit();
    case 'core.check_phase_gate': return core.checkPhaseGate(params.phase, params.gate);
    case 'core.resolve_conflict': return core.resolveConflict(params);
    case 'core.record_regression': return core.recordRegression(params);
    case 'core.record_principle': return core.recordPrinciple(params);
    case 'core.principles': return core.principles(params);
    case 'core.record_hidden_requirement': return core.recordHiddenRequirement(params);
    case 'core.hidden_requirements': return core.hiddenRequirements(params);
    case 'core.record_commercial': return core.recordCommercial(params);
    case 'core.commercial_intel': return core.commercialIntel(params);
    case 'core.record_tool': return core.recordTool(params);
    case 'core.tool_intel': return core.toolIntel(params);
    case 'core.record_archetype': return core.recordArchetype(params);
    case 'core.archetypes': return core.archetypes(params);
    case 'core.record_platform_semantic': return core.recordPlatformSemantic(params);
    case 'core.platform_semantics': return core.platformSemantics(params);
    case 'core.record_practice_parity': return core.recordPracticeParity(params);
    case 'core.practice_parity': return core.practiceParity(params);
    case 'core.record_skill_version': return core.recordSkillVersion(params);
    case 'core.skill_genealogy': return core.skillGenealogy(params);
    case 'core.context_pack_v2': return core.contextPackV2(params);
    case 'core.receipt_v2': return core.receiptV2(params);
    default: throw new Error(`unknown core capability: ${method}`);
  }
}

const isFixerSession = process.env.ANTIFAN_FIXER_SESSION === 'true' ||
  process.env.ANTIFAN_FIXER_SESSION === '1' ||
  process.argv.includes('--fixer');

// The fixer's permitted surface is policy, not a local constant: it lives beside the other B-Lite
// audits so the launcher, the pre-tool hook and the merge gate cannot drift into three lists.
// A module that does not yield the list refuses the fixer session outright — an unstated surface
// would silently widen to whatever the bridge grants, which is the failure this filter exists to stop.
let fixerToolSurface = null;
try {
  fixerToolSurface = createRequire(__filename)('../.canary/tools/fix-loop/audits.mjs').DEFAULT_PERMITTED_TOOLS;
} catch {}
if (isFixerSession && (!Array.isArray(fixerToolSurface) || fixerToolSurface.length === 0)) {
  console.error('TOOL_SURFACE_POLICY_UNLOADABLE: .canary/tools/fix-loop/audits.mjs did not yield DEFAULT_PERMITTED_TOOLS; refusing to launch a fixer session whose permitted tool surface is unstated.');
  process.exit(1);
}

function resolveSessionGrant() {
  if (process.env.ANTIFAN_SESSION_GRANT) {
    return process.env.ANTIFAN_SESSION_GRANT;
  }
  const grantArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--grant='));
  if (grantArg) {
    return grantArg.slice('--grant='.length);
  }
  return 'eval';
}

function resolveAllowedCapabilities() {
  if (isFixerSession) {
    return [...fixerToolSurface];
  }
  if (process.env.ANTIFAN_ALLOWED_CAPABILITIES || process.env.ANTIFAN_ALLOWED_CAPABILITY_NAMES) {
    const raw = process.env.ANTIFAN_ALLOWED_CAPABILITIES || process.env.ANTIFAN_ALLOWED_CAPABILITY_NAMES;
    try {
      if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch {}
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const allowArg = process.argv.find((a) => typeof a === 'string' && (a.startsWith('--allowed-capabilities=') || a.startsWith('--allow-capabilities=')));
  if (allowArg) {
    const val = allowArg.split('=')[1];
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function resolveForbiddenCapabilities() {
  if (process.env.ANTIFAN_FORBIDDEN_CAPABILITIES || process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES) {
    const raw = process.env.ANTIFAN_FORBIDDEN_CAPABILITIES || process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES;
    try {
      if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch {}
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const forbidArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--forbidden-capabilities='));
  if (forbidArg) {
    const val = forbidArg.split('=')[1];
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function matchCapabilityPattern(name, pattern) {
  const trimmed = pattern.trim();
  if (trimmed === '*' || trimmed === name) return true;
  if (!trimmed.includes('*') && !trimmed.includes('?')) return name === trimmed;
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(name);
}

function isCapabilityPermitted(name, allowedCaps, forbiddenCaps) {
  const mapped = CAPABILITY_MAP[name];
  if (forbiddenCaps && forbiddenCaps.length > 0) {
    for (const pat of forbiddenCaps) {
      if (matchCapabilityPattern(name, pat)) return false;
      if (mapped && matchCapabilityPattern(mapped, pat)) return false;
    }
  }
  if (allowedCaps && allowedCaps.length > 0) {
    let hasPositive = false;
    let allowedPositive = false;
    for (const rawPat of allowedCaps) {
      const pat = rawPat.trim();
      if (!pat) continue;
      if (pat.startsWith('!')) {
        if (matchCapabilityPattern(name, pat.slice(1))) return false;
        if (mapped && matchCapabilityPattern(mapped, pat.slice(1))) return false;
      } else {
        hasPositive = true;
        if (matchCapabilityPattern(name, pat)) allowedPositive = true;
        if (mapped && matchCapabilityPattern(mapped, pat)) allowedPositive = true;
      }
    }
    if (hasPositive && !allowedPositive) return false;
  }
  return true;
}

// ─── Client Dispatch Ceiling and Failure Classification (contract §2.6) ─────
// The server owns the per-capability response budget: policy.timeoutMs is one
// total budget, split by capability-transport.ts into an execution deadline plus
// a reserved cancellation-ack grace, and the transport answers
// EXECUTION_TIMEOUT_PENDING_CLEANUP if the handler is still releasing resources
// when the TOTAL budget expires. So the client owns exactly one number — a
// ceiling that must exceed the catalogue's largest policy — which makes every
// capability bounded server-side first and lets the client observe a typed
// terminal (or pending-cleanup) receipt instead of abandoning the invocation and
// replaying unknown work.
//
// A per-tool table used to live here and rotted silently: theme.debug_bundle
// carries a 60 s policy and had no entry, so the 30 s default fired first. The
// dominance of this ceiling over the catalogue is now asserted at compile time
// by scripts/check-mcp-budget-dominance.mjs, which also refuses a re-introduced
// per-tool table that under-cuts it. Never re-add one by hand.
const DEFAULT_CLIENT_TIMEOUT_MS = 240000;

// Operation outcomes, never transport faults: they describe what the capability
// did, so no reconnect, authority autoheal, or replay may follow them.
const OPERATION_TIMEOUT_CODES = new Set(['TIMEOUT', 'EXECUTION_TIMEOUT', 'EXECUTION_TIMEOUT_PENDING_CLEANUP']);

// Only transport/auth faults may retry, and only with the original identity.
const RETRYABLE_TRANSPORT_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ERROR',
  'CONNECTION_FAILED',
  'AUTHENTICATION_DENIED',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'REVISION_STALE',
  'ATTACHMENT_INVALID',
  'BOOTSTRAP_INVALID',
  'PAIRING_CHALLENGE_FAILED',
  'PAIRING_EXCHANGE_FAILED',
]);

function transportError(code, message, details) {
  const err = new Error(typeof message === 'string' && message.length > 0 ? message : code);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function isRetryableTransportError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (OPERATION_TIMEOUT_CODES.has(code)) return false;
  if (RETRYABLE_TRANSPORT_CODES.has(code)) return true;
  const text = String((err && err.message) || err || '');
  if (OPERATION_TIMEOUT_CODES.has(text)) return false;
  return /CONNECTION_CLOSED|CONNECTION_ERROR|CONNECTION_FAILED|Unauthorized|missing or invalid token|AUTHENTICATION_DENIED|WebSocket closed/i.test(text);
}

/**
 * One invocation identity per logical call. `idempotencyKey` is the ledger join
 * key; it is minted once and reused across eligible transport retries so a retry
 * joins the original invocation instead of minting a new one.
 */
function resolveInvocationIdentity(callerRequestId, params) {
  const p = params && typeof params === 'object' ? params : {};
  const explicitKey = typeof p.idempotencyKey === 'string' && p.idempotencyKey.trim() ? p.idempotencyKey.trim() : null;
  const explicitRequest = typeof p.requestId === 'string' && p.requestId.trim() ? p.requestId.trim() : null;
  const caller = callerRequestId !== undefined && callerRequestId !== null && String(callerRequestId).trim()
    ? String(callerRequestId).trim()
    : null;
  return {
    requestId: explicitRequest || (caller ? `req-mcp-${caller}` : `req-${crypto.randomUUID()}`),
    idempotencyKey: explicitKey || (caller ? `idem-mcp-${caller}` : `idem-${crypto.randomUUID()}`),
  };
}

function persistAuthorityRevision(revision) {
  if (typeof revision === 'string' && revision.startsWith('rev_')) {
    currentAuthorityRevision = revision;
  }
}

/**
 * Nonterminal surface for EXECUTION_TIMEOUT_PENDING_CLEANUP: the invocation owns
 * resources and has no terminal receipt yet. It is joinable only by its own
 * identity (re-issue with the same idempotencyKey).
 */
function buildPendingCleanupResult(payload, entry) {
  const details = payload && typeof payload.details === 'object' && payload.details !== null ? payload.details : {};
  const invocationId = typeof details.invocationId === 'string'
    ? details.invocationId
    : (typeof payload.invocationId === 'string' ? payload.invocationId : null);
  return {
    _type: 'PENDING_CLEANUP',
    code: 'EXECUTION_TIMEOUT_PENDING_CLEANUP',
    message: typeof payload.message === 'string' && payload.message
      ? payload.message
      : 'Capability execution timed out with owned-resource cleanup still pending. No terminal receipt exists yet.',
    invocationId,
    cleanupPending: true,
    terminal: false,
    joinableBy: 'idempotencyKey',
    requestId: entry.requestId,
    idempotencyKey: entry.idempotencyKey,
  };
}

// ─── Multiplexed Persistent Dispatch Socket ──────────────────────────────────
let dispatchWs = null;
let dispatchConnecting = null;
const pendingDispatchCalls = new Map(); // id -> { resolve, reject, timer }

function wireDispatchSocket(ws) {
  ws.on('message', (raw) => {
    try {
      const response = JSON.parse(raw.toString());
      if (!response || !response.id) {
        return;
      }
      const payload = response.data && typeof response.data === 'object' ? response.data : null;
      if (payload) {
        const rev = payload.replacementAuthorityRevision || payload.authorityRevision;
        if (rev) {
          persistAuthorityRevision(rev);
        }
      }
      if (!pendingDispatchCalls.has(response.id)) {
        return;
      }
      const entry = pendingDispatchCalls.get(response.id);
      pendingDispatchCalls.delete(response.id);
      clearTimeout(entry.timer);
      if (response.success) {
        if (response.data && typeof response.data === 'object') {
          persistAuthorityRevision(response.data.authorityRevision || response.data.replacementAuthorityRevision);
          if (response.data.data !== undefined) {
            entry.resolve(response.data.data);
            return;
          }
        }
        entry.resolve(response.data);
      } else {
        const payload = response.data && typeof response.data === 'object' ? response.data : {};
        persistAuthorityRevision(payload.replacementAuthorityRevision || payload.authorityRevision);
        const code = typeof payload.code === 'string' && payload.code
          ? payload.code
          : (typeof response.error === 'string' && response.error.includes(':')
            ? response.error.slice(0, response.error.indexOf(':'))
            : 'CAPABILITY_ERROR');
        if (code === 'EXECUTION_TIMEOUT_PENDING_CLEANUP') {
          // Nonterminal: the invocation still owns resources. Surface the typed
          // pending state; never reject into the retry path.
          process.stderr.write(`[MCP Proxy RPC Pending Cleanup] ${JSON.stringify(response)}\n`);
          entry.resolve(buildPendingCleanupResult(payload, entry));
          return;
        }
        process.stderr.write(`[MCP Proxy RPC Error] ${JSON.stringify(response)}\n`);
        const errorText = typeof response.error === 'string' && response.error
          ? response.error
          : JSON.stringify(payload.code ? payload : { code: 'CAPABILITY_ERROR', message: 'AntiFan RPC failed' });
        entry.reject(transportError(code, errorText, payload.details));
      }
    } catch {}
  });

  ws.once('error', (err) => {
    dispatchConnecting = null;
    if (dispatchWs === ws) dispatchWs = null;
    for (const [, entry] of pendingDispatchCalls.entries()) {
      clearTimeout(entry.timer);
      entry.reject(transportError('CONNECTION_ERROR', JSON.stringify({ code: 'CONNECTION_ERROR', message: `Dispatch WebSocket error: ${err.message}` })));
    }
    pendingDispatchCalls.clear();
  });

  ws.once('close', (code, reason) => {
    dispatchConnecting = null;
    if (dispatchWs === ws) dispatchWs = null;
    const reasonText = reason && reason.length ? reason.toString() : '';
    const detail = `Dispatch WebSocket closed while request in flight (code=${code}${reasonText ? `, reason=${reasonText}` : ''})`;
    for (const [, entry] of pendingDispatchCalls.entries()) {
      clearTimeout(entry.timer);
      entry.reject(transportError('CONNECTION_CLOSED', JSON.stringify({ code: 'CONNECTION_CLOSED', message: detail, closeCode: code, closeReason: reasonText || undefined })));
    }
    pendingDispatchCalls.clear();
  });
}

// ─── Pairing availability contract ───────────────────────────────────────────
// The bridge mints pairing challenges into a SMALL on-disk queue and only used to refill it when a
// consumer asked, paying a PowerShell DACL cost (~10 s on this host) inside the request. Measured
// live with five concurrent pairs against the running app: 24.4 s / 22.6 s / 4.3 s / 3.8 s / 4.0 s.
// The pairing socket below gives up at 15 s, so those clients abandoned a bridge that was alive and
// a second away from answering — and then reported it as DOWN. Two independent defences live here,
// and they compose:
//   1. every pairing failure is CLASSIFIED, so a policy refusal is never retried while a transient
//      stall always is, and the real reason reaches the caller instead of one fixed string; and
//   2. retries are JITTERED, so N clients that all fail at the same instant do not re-ask in
//      lockstep and rebuild the very burst that caused the failure.
const PAIRING_ATTEMPT_LIMIT = 4;
const PAIRING_ATTEMPT_TIMEOUT_MS = 8000;
const PAIRING_TOTAL_BUDGET_MS = 30000;
const PAIRING_RETRY_BASE_MS = 250;
const PAIRING_RETRY_CAP_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter: the delay is drawn from [ceiling/2, ceiling]. A fixed exponential schedule would
// merely re-synchronise the herd it exists to break up.
function pairingBackoffMs(attempt) {
  const ceiling = Math.min(PAIRING_RETRY_CAP_MS, PAIRING_RETRY_BASE_MS * Math.pow(2, attempt));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

// Refusals a retry cannot fix, because they describe the REQUEST rather than the moment: the grant
// name is wrong, the client class does not match, the code was revoked. Retrying one of these would
// hammer the bridge, still fail, and hide a real policy error behind a timeout. Everything else — a
// stalled socket, a refused connection, a depleted queue, a 5xx, or a code consumed or expired
// before we could spend it — is a transient availability fact and is retried with a FRESH challenge.
// A retry never re-presents the previous code, so the single-use guarantee is untouched: the bridge
// still refuses the old code with 409, and this process never sends it twice.
const TERMINAL_PAIRING_ERRORS = new Set([
  'PAIRING_GRANT_UNKNOWN',
  'PAIRING_GRANT_CEILING_EXCEEDED',
  'PAIRING_CLIENT_CLASS_MISMATCH',
  'PAIRING_CLIENT_ID_MISMATCH',
  'PAIRING_CODE_REVOKED',
  'INVALID_PAIRING_REQUEST',
  'INVALID_CLIENT_CLASS',
  'LAN_ACCESS_FORBIDDEN',
  'SECRETS_IN_URL_FORBIDDEN',
  'PAYLOAD_TOO_LARGE',
]);

function pairingFailureParts(err) {
  return {
    msg: err && err.message ? String(err.message) : String(err || ''),
    status: err && typeof err.status === 'number' ? err.status : null,
    errorCode: err && typeof err.errorCode === 'string' ? err.errorCode : null,
  };
}

function isTerminalPairingFailure(err) {
  const { msg, errorCode } = pairingFailureParts(err);
  if (errorCode && TERMINAL_PAIRING_ERRORS.has(errorCode)) return true;
  for (const code of TERMINAL_PAIRING_ERRORS) {
    if (msg.includes(code)) return true;
  }
  return false;
}

// 'ECONNREFUSED' means nothing is listening (bridge not running). A timeout or a depleted queue
// means the bridge IS listening and could not serve pairing in time. Those two need opposite
// responses from an operator, so they must not collapse into one string.
function classifyPairingFailure(err) {
  const { msg, status, errorCode } = pairingFailureParts(err);
  if (status === 404 || errorCode === 'CHALLENGE_QUEUE_DEPLETED' || /CHALLENGE_QUEUE_DEPLETED/i.test(msg)) {
    return 'PAIRING_QUEUE_DEPLETED';
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return 'BRIDGE_UNREACHABLE';
  if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(errorCode || '')) return 'BRIDGE_UNREACHABLE';
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'PAIRING_TIMEOUT';
  if (status !== null && status >= 500) return 'BRIDGE_ERROR';
  if (errorCode) return errorCode;
  return 'PAIRING_FAILED';
}

function describePairingFailure(err) {
  const { msg, status, errorCode } = pairingFailureParts(err);
  const label = errorCode || (status !== null ? `HTTP ${status}` : classifyPairingFailure(err));
  return `${label}: ${msg}`.trim();
}

function httpJsonPost(host, port, requestPath, payload, timeoutMs = PAIRING_ATTEMPT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload || {});
    const req = http.request({
      hostname: host,
      port: port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed.message || parsed.error || `HTTP ${res.statusCode}`;
            const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
            // Carry the typed reason, not just the prose: the classifier and the CONNECTION_FAILED
            // cause both key off these, and re-deriving them from a message string is guesswork.
            err.status = typeof res.statusCode === 'number' ? res.statusCode : null;
            err.errorCode = typeof parsed.error === 'string' ? parsed.error : null;
            reject(err);
          }
        } catch {
          reject(new Error(`Failed to parse JSON response (${res.statusCode}): ${data}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Pairing request timeout after ${timeoutMs}ms (${requestPath})`);
      err.errorCode = 'PAIRING_TIMEOUT';
      req.destroy(err);
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.write(postData);
    req.end();
  });
}

// One pairing attempt per iteration, each with its OWN freshly claimed challenge. The retry exists
// because the bridge can legitimately need a moment to refill its small challenge queue while other
// clients pair; it does not relax any check, and it never re-sends a code the bridge already saw.
async function performPairingExchange(host, port, options = {}) {
  const budgetMs = typeof options.budgetMs === 'number' ? options.budgetMs : PAIRING_TOTAL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let lastError = null;

  for (let attempt = 0; attempt < PAIRING_ATTEMPT_LIMIT; attempt++) {
    if (attempt > 0) {
      const waitMs = pairingBackoffMs(attempt - 1);
      process.stderr.write(
        `[AntiFan Pairing] attempt ${attempt + 1}/${PAIRING_ATTEMPT_LIMIT} for ${host}:${port} in ${waitMs}ms after ` +
          `${describePairingFailure(lastError)}\n`
      );
      await sleep(waitMs);
    }

    try {
      const challenge = await httpJsonPost(host, port, '/api/pairing/challenge', {});
      const code = challenge?.code;
      if (!challenge?.success || !code) {
        const err = new Error(`PAIRING_CHALLENGE_FAILED: ${challenge?.message || challenge?.error || 'No challenge code returned'}`);
        err.errorCode = 'PAIRING_CHALLENGE_FAILED';
        throw err;
      }
      const exchange = await httpJsonPost(host, port, '/api/pairing/exchange', {
        code,
        clientClass: 'mcp',
        // Declare the authority this session needs. Omitting it lets the bridge fall back to a silent
        // 'write' grant, which then refuses every eval-risk capability (anti.browser.evaluate,
        // anti.inspect.eval) with a POLICY_DENIED that never mentions the grant.
        requestedGrant: resolveSessionGrant(),
      });
      if (!exchange?.success || !exchange?.secret) {
        const err = new Error(`PAIRING_EXCHANGE_FAILED: ${exchange?.message || exchange?.error || 'No secret returned'}`);
        err.errorCode = 'PAIRING_EXCHANGE_FAILED';
        throw err;
      }
      assertGrantNotDowngraded(exchange);
      return exchange;
    } catch (err) {
      lastError = err;
      if (isTerminalPairingFailure(err)) throw err;
      if (Date.now() >= deadline) break;
    }
  }

  const fatal = new Error(
    `PAIRING_UNAVAILABLE after ${PAIRING_ATTEMPT_LIMIT} attempts against ${host}:${port}: ${describePairingFailure(lastError)}`
  );
  fatal.errorCode = classifyPairingFailure(lastError);
  fatal.cause = lastError;
  throw fatal;
}

// A silent downgrade is indistinguishable from "the tool is not permitted" once the agent is deep in
// a run, so surface it at pairing time instead.
const GRANT_RANKS = { read: 1, write: 2, execute: 3, eval: 4 };
function assertGrantNotDowngraded(exchange) {
  const requested = resolveSessionGrant();
  const granted = exchange?.grant;
  if (!(requested in GRANT_RANKS) || !(granted in GRANT_RANKS)) return;
  if (GRANT_RANKS[granted] < GRANT_RANKS[requested]) {
    process.stderr.write(
      `ANTIFAN_GRANT_DOWNGRADED: requested grant '${requested}' but the bridge granted '${granted}'; ` +
        'eval-risk capabilities will be refused with POLICY_DENIED.\n'
    );
  }
}

// ─── Autoheal diagnostics and live-authority reuse ───────────────────────────
// Why this exists: `CONNECTION_FAILED: Unable to connect to live AntiFan Desktop bridge after
// autoheal` was thrown no matter WHAT actually went wrong — a refused socket, a pairing queue with
// no code left, an exchange that answered 429. Each per-candidate reason was written to stderr
// (which an MCP stdio host discards) and then dropped, so an operator looking at a bridge that was
// serving other clients read "down". The reasons are now retained and composed into the error the
// caller sees, so the message names the underlying cause instead of hiding it.
let lastAutohealFailure = null;
let lastAutohealFailures = [];

function rememberAutohealFailure(text) {
  lastAutohealFailure = text;
  lastAutohealFailures.push(text);
  if (lastAutohealFailures.length > 8) lastAutohealFailures.shift();
}

// Minimal request/response over an already-open socket: the reuse probe needs exactly one verb and
// must not drag in the dispatch plumbing (pendingDispatchCalls, binding, heartbeats) that would then
// have to be unwound if the probe fails.
function wsRequest(ws, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = `probe-${crypto.randomUUID()}`;
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`Probe timeout waiting for ${method}`));
    }, timeoutMs);
    function onMessage(raw) {
      let resp;
      try { resp = JSON.parse(raw.toString()); } catch { return; }
      if (!resp || resp.id !== id) return;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      if (resp.success) resolve(resp.data);
      else reject(new Error(resp.error || `${method} refused`));
    }
    ws.on('message', onMessage);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      reject(err);
    }
  });
}

// Reuse before re-pair. Everything the caller needs is already in hand: the attachment id, its
// secret, its authority revision and its bound tab. Minting a replacement costs a single-use pairing
// code — the scarcest thing in this system during a burst — and grants nothing that was not already
// held, so reuse can never widen authority. Re-pairing is required only when the host really did
// invalidate the attachment, which is what a rebuild does to every connected client at once.
// Liveness is proven twice over: the WebSocket upgrade itself (the bridge closes 4001 for an
// attachment that is not active and unexpired) and a bound `renewSession`, which touches no
// capability and carries the same attachment id and secret.
async function tryReuseLiveAttachment(candidate) {
  const existing = getBootstrap();
  if (!existing || !existing.secret || !existing.attachmentId) return null;
  if (Number(existing.port) !== Number(candidate.port)) return null;
  let ws = null;
  try {
    ws = new WebSocket(`ws://${candidate.host}:${candidate.port}`, {
      headers: {
        Authorization: `Bearer ${existing.secret}`,
        'x-antifan-attachment-secret': existing.secret,
      },
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error('Attachment reuse probe timed out'));
        }
      }, 3000);
      ws.once('open', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } });
      ws.once('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
      ws.once('close', (code, reason) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Attachment reuse refused (${code}): ${reason || ''}`));
        }
      });
    });

    await wsRequest(ws, 'antifan.cli.renewSession', {
      attachmentId: existing.attachmentId,
      secret: existing.secret,
      ownerPid: existing.ownerPid,
      extensionMs: 7_200_000,
    }, 4000);

    dynamicBootstrap = { ...existing, token: existing.token || existing.secret };
    if (existing.authorityRevision) currentAuthorityRevision = existing.authorityRevision;
    // Wire the dispatch socket before the heartbeat, exactly as the pairing path does, so no
    // recovery path can observe an unbound dispatcher while the binding is being restored.
    dispatchWs = ws;
    wireDispatchSocket(ws);
    startHeartbeat(dynamicBootstrap);
    process.stderr.write(
      `[AntiFan Autoheal] Reused live attachment ${String(existing.attachmentId).slice(0, 24)}... on ` +
        `${candidate.host}:${candidate.port}; no pairing code spent.\n`
    );
    return dynamicBootstrap;
  } catch (reuseErr) {
    if (ws) { try { ws.close(); } catch {} }
    process.stderr.write(
      `[AntiFan Autoheal] Held authority not reusable on ${candidate.host}:${candidate.port}: ${reuseErr.message}\n`
    );
    return null;
  }
}

async function autohealSession() {
  const candidates = resolveFailoverCandidates();
  lastAutohealFailures = [];
  if (candidates.length === 0) {
    rememberAutohealFailure('BRIDGE_NOT_RUNNING: no endpoint discovered (no pin and no discovery file)');
    process.stderr.write('MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge is not running (no candidates discovered).\n');
    return null;
  }
  for (const candidate of candidates) {
    try {
      // Reuse first: a client that already holds live authority never needs a pairing code, so a
      // restart only costs a re-pair for the clients whose attachment was actually invalidated.
      const reused = await tryReuseLiveAttachment(candidate);
      if (reused) return reused;

      let authSecret = candidate.token || '';
      let pairedExchange = null;
      try {
        pairedExchange = await performPairingExchange(candidate.host, candidate.port);
        authSecret = pairedExchange.secret;
      } catch (pairErr) {
        // Keep the reason. Falling through to a held secret is still worth ONE attempt (the bridge
        // may accept it), but when that also fails the pairing failure is what explains why.
        if (!authSecret) {
          rememberAutohealFailure(`${candidate.host}:${candidate.port} ${describePairingFailure(pairErr)}`);
          throw pairErr;
        }
        process.stderr.write(
          `[AntiFan Autoheal] Pairing refused on ${candidate.host}:${candidate.port} ` +
            `(${describePairingFailure(pairErr)}); retrying once with the held secret.\n`
        );
      }

      const wsUrl = `ws://${candidate.host}:${candidate.port}`;
      const headers = {};
      if (pairedExchange && pairedExchange.secret) {
        headers['x-antifan-attachment-secret'] = pairedExchange.secret;
        headers['Authorization'] = `Bearer ${pairedExchange.secret}`;
      } else if (authSecret) {
        headers['Authorization'] = `Bearer ${authSecret}`;
        headers['x-antifan-attachment-secret'] = authSecret;
      }
      const ws = new WebSocket(wsUrl, { headers });

      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { ws.close(); } catch {}
            reject(new Error('Autoheal WebSocket timeout'));
          }
        }, 15000);

        ws.once('open', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
        ws.once('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
        ws.once('close', (code, reason) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Autoheal WebSocket closed early (${code}): ${reason || ''}`));
          }
        });
      });

      let session = null;
      if (pairedExchange && pairedExchange.secret && pairedExchange.attachmentId) {
        let resolvedTabId = process.env.ANTIFAN_BOUND_TAB_ID;
        try {
          const tabListId = 'tabs-' + crypto.randomUUID();
          const tabResult = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              ws.removeListener('message', onMsg);
              resolve(null);
            }, 3000);
            const onMsg = (raw) => {
              try {
                const resp = JSON.parse(raw.toString());
                if (resp && resp.id === tabListId) {
                  clearTimeout(timer);
                  ws.removeListener('message', onMsg);
                  resolve(resp.data?.data || resp.data || []);
                }
              } catch {}
            };
            ws.on('message', onMsg);
            ws.send(JSON.stringify({
              id: tabListId,
              method: 'antifan.capability.dispatch',
              params: {
                name: 'browser.list-tabs',
                attachmentId: pairedExchange.attachmentId,
                attachmentSecret: pairedExchange.secret,
                authorityRevision: pairedExchange.authorityRevision,
                params: { all: true },
              },
            }));
          });
          if (Array.isArray(tabResult) && tabResult.length > 0) {
            const attached = tabResult.find((t) => t.attached) || tabResult.find((t) => !t.offscreen) || tabResult[0];
            if (attached && attached.id) {
              resolvedTabId = attached.id;
            }
          }
        } catch {}
        session = {
          attachmentId: pairedExchange.attachmentId,
          secret: pairedExchange.secret,
          authorityRevision: pairedExchange.authorityRevision,
          tabId: resolvedTabId || 'default-tab',
          runId: pairedExchange.runId,
          attemptId: pairedExchange.attemptId,
          projectId: pairedExchange.projectId,
          workspaceId: pairedExchange.workspaceId,
        };
      } else {
        const startId = 'autoheal-' + crypto.randomUUID();
        session = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            ws.removeListener('message', onMsg);
            reject(new Error('startSession timeout'));
          }, 5000);
          const onMsg = (raw) => {
            try {
              const resp = JSON.parse(raw.toString());
              if (resp && resp.id === startId) {
                clearTimeout(timer);
                ws.removeListener('message', onMsg);
                if (resp.success && resp.data) {
                  resolve(resp.data);
                } else {
                  reject(new Error(resp.error || 'startSession failed'));
                }
              }
            } catch {}
          };
          ws.on('message', onMsg);
          const rawTerminalId = process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID || process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID || process.env.ANTIFAN_TERMINAL_SESSION_ID;
          const rawGeneration = process.env.ANTIFAN_TERMINAL_AFFINITY_GENERATION || process.env.ANTIFAN_TERMINAL_GENERATION;
          const targetGrant = resolveSessionGrant();
          const allowedCaps = resolveAllowedCapabilities();
          const forbiddenCaps = resolveForbiddenCapabilities();
          const startParams = {
            backendId: 'cli',
            grant: targetGrant,
            cwd: process.cwd(),
            attachmentId: pairedExchange?.attachmentId || undefined,
            terminalSessionId: rawTerminalId ? String(rawTerminalId).trim() : undefined,
            terminalGeneration: rawGeneration ? String(rawGeneration).trim() : undefined,
          };
          if (allowedCaps && allowedCaps.length > 0) {
            startParams.allowedCapabilityNames = allowedCaps;
          }
          if (forbiddenCaps && forbiddenCaps.length > 0) {
            startParams.forbiddenCapabilityNames = forbiddenCaps;
          }
          ws.send(JSON.stringify({
            id: startId,
            method: 'antifan.cli.startSession',
            params: startParams,
          }));
        });
      }
      if (!session || !session.attachmentId || !session.secret || !session.authorityRevision || !session.tabId) {
        const missing = [
          !session?.attachmentId && 'attachmentId',
          !session?.secret && 'secret',
          !session?.authorityRevision && 'authorityRevision',
          !session?.tabId && 'tabId',
        ].filter(Boolean).join(', ');
        const err = new Error(`BOOTSTRAP_INVALID: Bridge startSession response missing mandatory fields (${missing})`);
        err.code = 'BOOTSTRAP_INVALID';
        throw err;
      }

      dynamicBootstrap = {
        port: candidate.port,
        host: candidate.host,
        secret: session.secret,
        attachmentId: session.attachmentId,
        authorityRevision: session.authorityRevision,
        runId: session.runId,
        attemptId: session.attemptId,
        projectId: session.projectId,
        workspaceId: session.workspaceId,
        tabId: session.tabId,
        token: candidate.token || session.secret,
      };
      currentAuthorityRevision = session.authorityRevision;

      // The healed endpoint may be a different instance than the one this session
      // was pinned to: say so, and rebind to the tab that instance actually gave us
      // (the previously bound tab does not exist there).
      const rawPinnedPid = parseInt(process.env.ANTIFAN_BRIDGE_PID || '', 10);
      const pinnedPid = Number.isInteger(rawPinnedPid) && rawPinnedPid > 0 ? rawPinnedPid : null;
      const answeredPid = typeof session.runtimePid === 'number' && Number.isInteger(session.runtimePid) && session.runtimePid > 0
        ? session.runtimePid
        : null;
      if (pinnedPid !== null && answeredPid !== pinnedPid) {
        process.stderr.write(`[AntiFan Autoheal] FOREIGN_INSTANCE_ATTACH: pinned pid ${pinnedPid} did not answer; attached to ${candidate.host}:${candidate.port} (pid ${answeredPid === null ? 'unknown' : answeredPid})\n`);
      }
      process.env.ANTIFAN_BOUND_TAB_ID = session.tabId;

      // Wire the dispatch socket before the heartbeat so no recovery path can
      // observe an unbound dispatcher while the binding is being rebound.
      dispatchWs = ws;
      wireDispatchSocket(ws);
      startHeartbeat(dynamicBootstrap);
      return dynamicBootstrap;
    } catch (err) {
      rememberAutohealFailure(`${candidate.host}:${candidate.port} ${err.message}`);
      process.stderr.write(`[AntiFan Autoheal] Candidate ${candidate.host}:${candidate.port} failed: ${err.message}\n`);
    }
  }
  const cause = lastAutohealFailures.join(' | ') || 'no candidate answered';
  lastAutohealFailure = cause;
  // The prefix is kept because other tooling greps for it; the sentence after it is now true. A
  // refused connection means nothing is listening; a pairing timeout or a depleted queue means the
  // bridge IS listening and could not grant access in the client's budget. Reporting the second as
  // "failed to connect" is the misleading-availability defect this whole path exists to remove.
  const allRefused = lastAutohealFailures.length > 0
    && lastAutohealFailures.every((f) => /BRIDGE_UNREACHABLE|ECONNREFUSED|ECONNRESET|EPIPE|not running|no endpoint discovered/i.test(f));
  process.stderr.write(
    'MCP_BRIDGE_OFFLINE: ' +
      (allRefused
        ? 'AntiFan Desktop Bridge is not listening'
        : 'AntiFan Desktop Bridge is up but did not grant access (this is NOT a down bridge)') +
      ` — ${cause}\n`
  );
  return null;
}

async function ensureDispatchSocket(bootstrap) {
  if (dispatchWs && dispatchWs.readyState === WebSocket.OPEN) {
    return dispatchWs;
  }
  if (dispatchConnecting) {
    return dispatchConnecting;
  }

  dispatchConnecting = (async () => {
    if (bootstrap && bootstrap.port && (bootstrap.token || bootstrap.secret)) {
      try {
        const authHeaders = {};
        if (bootstrap.secret) {
          authHeaders['X-Antifan-Attachment-Secret'] = bootstrap.secret;
          authHeaders['Authorization'] = `Bearer ${bootstrap.secret}`;
        }
        if (bootstrap.token && !authHeaders['Authorization']) {
          authHeaders['Authorization'] = `Bearer ${bootstrap.token}`;
        }
        const url = `ws://127.0.0.1:${bootstrap.port}`;

        const ws = new WebSocket(url, { headers: authHeaders });
        await new Promise((resolve, reject) => {
          let settled = false;
          const connectTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { ws.close(); } catch {}
              reject(new Error('Connection timeout'));
            }
          }, 3000);

          ws.once('open', () => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              resolve();
            }
          });
          ws.once('error', (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              reject(err);
            }
          });
          ws.once('close', (code) => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              reject(new Error(`Closed early with code ${code}`));
            }
          });
        });

        dispatchWs = ws;
        wireDispatchSocket(ws);
        return ws;
      } catch (err) {
        process.stderr.write(`[AntiFan MCP] Initial connection failed (${err.message}). Autohealing...\n`);
      }
    }

    const healed = await autohealSession();
    if (healed && dispatchWs && dispatchWs.readyState === WebSocket.OPEN) {
      return dispatchWs;
    }

    // The underlying cause is the whole point of this error, so it travels WITH it. The original
    // leading sentence is preserved because callers match on it, but the trailing clause now says
    // whether the bridge was refused, unreachable, or simply unable to hand out pairing codes —
    // three different operator responses that used to be one indistinguishable string.
    const failureCause = lastAutohealFailure || 'no candidate answered';
    throw transportError('CONNECTION_FAILED', JSON.stringify({
      code: 'CONNECTION_FAILED',
      message: `Unable to connect to live AntiFan Desktop bridge after autoheal: ${failureCause}`,
      reason: failureCause,
      candidates: lastAutohealFailures.slice(),
    }));
  })().finally(() => {
    dispatchConnecting = null;
  });

  return dispatchConnecting;
}

async function invoke(method, params = {}, callerRequestId) {
  const allowedCaps = resolveAllowedCapabilities();
  const forbiddenCaps = resolveForbiddenCapabilities();
  if (!isCapabilityPermitted(method, allowedCaps, forbiddenCaps)) {
    const err = new Error(`REFUSED_TOOL_SURFACE: Capability '${method}' is forbidden by session tool surface policy`);
    err.code = 'REFUSED_TOOL_SURFACE';
    throw err;
  }
  // Required-field contract is enforced before any dispatch (bridge or local):
  // the advertised schema is a promise published by this surface.
  const declaredRequired = (definitions.find(([defName]) => defName === method) || [])[3] || [];
  const missingRequiredEarly = declaredRequired.filter((field) => {
    const value = params[field];
    if (value === undefined || value === null) return true;
    return typeof value === 'string' && value.trim() === '';
  });
  if (missingRequiredEarly.length > 0) {
    throw new Error(JSON.stringify({
      code: 'INVALID_ARGUMENT',
      message: `Capability '${method}' requires ${missingRequiredEarly.join(', ')}, and this call supplied no usable value for ${missingRequiredEarly.length === 1 ? 'it' : 'them'}. ` +
        'The field is refused rather than defaulted, because a default would act on a target the caller never named. ' +
        `Supply ${missingRequiredEarly.length === 1 ? 'the field' : 'the fields'} explicitly and retry.`,
      details: { capability: method, missing: missingRequiredEarly },
    }));
  }
  // Local core.* capabilities: the Super Core evidence store is a local SQLite
  // database, not a bridge capability. Handle in-process BEFORE the bootstrap
  // gate — a local store must not depend on the desktop bridge being live.
  const mappedEarly = CAPABILITY_MAP[method] || method;
  if (mappedEarly.startsWith('core.')) {
    return invokeCore(mappedEarly, params);
  }
  let bootstrap = getBootstrap();
  if (!bootstrap || !bootstrap.secret) {
    try {
      await autohealSession();
    } catch (err) {
      process.stderr.write(`[AntiFan MCP] Autoheal failed: ${err.message}\n`);
    }
    bootstrap = getBootstrap();
    if (!bootstrap || !bootstrap.secret) {
      process.stderr.write(
        `MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge did not grant access — ${lastAutohealFailure || 'no candidate answered'}\n`
      );
      throw transportError('MCP_CONTEXT_REQUIRED', JSON.stringify({ code: 'MCP_CONTEXT_REQUIRED', message: 'OMP MCP proxy requires an authoritative Main bootstrap' }));
    }
  }

  const mapped = CAPABILITY_MAP[method] || method;
  // One ceiling for every capability: the server's own budget is the bound, and
  // it is the server that answers first (see DEFAULT_CLIENT_TIMEOUT_MS).
  const timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS;
  // Invocation identity is minted ONCE per logical call, outside the retryable
  // dispatch function: an eligible transport retry resends the same
  // requestId/idempotencyKey and therefore joins the original ledger entry
  // instead of minting a new invocation.
  const identity = resolveInvocationIdentity(callerRequestId, params);
  // Transport-only arguments are consumed here and never forwarded to the
  // capability. The remaining params are frozen for the life of the invocation so
  // a retry stays digest-identical to the original (the ledger joins on digest).
  const effectiveParams = { ...params };
  delete effectiveParams.idempotencyKey;
  delete effectiveParams.requestId;
  delete effectiveParams.callerRequestId;
  const boundTabId = bootstrap.tabId || process.env.ANTIFAN_BOUND_TAB_ID;
  // The advertised schema is a promise published by THIS surface, enforced at
  // invoke head (before bridge or local dispatch). `0`, `false` and non-empty
  // strings are real values; only absent, null and blank count as omitted.
  // Reaching here means every required field is genuinely present, so the
  // convenience default below can only ever apply to a tool whose schema keeps
  // tabId optional.
  if (!effectiveParams.tabId && boundTabId) {
    effectiveParams.tabId = boundTabId;
  }
  if (mapped === 'artifact.read') {
    const rawLimit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 32768;
    effectiveParams.limit = Math.min(rawLimit, 32768); // Bounded chunk size: <= 32 KiB per frame
  }
  const sendDispatch = async (currentBoot) => {
    const ws = await ensureDispatchSocket(currentBoot);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDispatchCalls.delete(id);
        // Client budget exhaustion is an operation outcome, not a transport
        // fault: never reconnect and never replay. The server still owns the
        // invocation; a late response is discarded by the unknown-id guard in
        // wireDispatchSocket and leaves the socket usable.
        reject(transportError('TIMEOUT', JSON.stringify({ code: 'TIMEOUT', message: `AntiFan RPC timed out: ${mapped}` })));
      }, timeoutMs);

      pendingDispatchCalls.set(id, {
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        resolve: (data) => {
          const targetTabId =
            (data && typeof data === 'object' && typeof data.tabId === 'string' && data.tabId) ||
            (data && typeof data === 'object' && data.target && typeof data.target.tabId === 'string' && data.target.tabId) ||
            effectiveParams.tabId;
          if (
            (mapped === 'browser.switch-tab' || mapped === 'browser.rebind-target' || mapped === 'browser.set-automation-target') &&
            typeof targetTabId === 'string' && targetTabId.length > 0
          ) {
            currentBoot.tabId = targetTabId;
            process.env.ANTIFAN_BOUND_TAB_ID = targetTabId;
          } else if (mapped === 'browser.open-tab' && data && typeof data === 'object' && typeof data.tabId === 'string') {
            currentBoot.tabId = data.tabId;
            process.env.ANTIFAN_BOUND_TAB_ID = data.tabId;
          }
          resolve(data);
        },
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify({
          id,
          method: 'antifan.capability.dispatch',
          params: {
            name: mapped,
            params: effectiveParams,
            requestId: identity.requestId,
            idempotencyKey: identity.idempotencyKey,
            attachmentId: currentBoot.attachmentId,
            attachmentSecret: currentBoot.secret,
            authorityRevision: currentAuthorityRevision || currentBoot.authorityRevision,
            attachmentClaims: {
              attachmentSecret: currentBoot.secret,
              attachmentId: currentBoot.attachmentId,
              authorityRevision: currentAuthorityRevision || currentBoot.authorityRevision,
              runId: currentBoot.runId,
              attemptId: currentBoot.attemptId,
              projectId: currentBoot.projectId,
              workspaceId: currentBoot.workspaceId,
              ownerPid: currentBoot.ownerPid,
            },
          },
        }));
      } catch (err) {
        clearTimeout(timer);
        pendingDispatchCalls.delete(id);
        reject(err);
      }
    });
  };

  try {
    return await sendDispatch(bootstrap);
  } catch (err) {
    // Only connection/auth faults may retry; operation timeouts never do.
    if (!isRetryableTransportError(err)) throw err;
    const errStr = String(err?.message || err);
    process.stderr.write(`[AntiFan MCP] Connection or auth issue detected (${errStr}). Autohealing...\n`);
    if (dispatchWs) {
      try { dispatchWs.close(); } catch {}
      dispatchWs = null;
    }
    const healed = await autohealSession();
    if (healed && healed.secret) {
      return await sendDispatch(healed);
    }
    // No failover candidate answered, but the original bridge may still be
    // alive (single-instance app): one same-endpoint reconnect with the
    // existing secret before giving up.
    try {
      return await sendDispatch(bootstrap);
    } catch {
      throw err;
    }
  }
}

// ─── Dedicated Isolated Heartbeat Channel ────────────────────────────────────
let heartbeatTimer = null;
let heartbeatWs = null;
let heartbeatBusy = false;
let heartbeatFailureLogged = false;
let heartbeatReconnectTimer = null;
let heartbeatPendingTimer = null;

function clearHeartbeatPending() {
  if (heartbeatPendingTimer) {
    clearTimeout(heartbeatPendingTimer);
    heartbeatPendingTimer = null;
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatReconnectTimer) {
    clearTimeout(heartbeatReconnectTimer);
    heartbeatReconnectTimer = null;
  }
  clearHeartbeatPending();
  if (heartbeatWs) {
    try { heartbeatWs.close(); } catch {}
    heartbeatWs = null;
  }
  heartbeatBusy = false;
}

function heartbeatUrl(bootstrap) {
  return `ws://127.0.0.1:${bootstrap.port}`;
}

function scheduleHeartbeatReconnect(bootstrap) {
  if (heartbeatTimer === null || heartbeatReconnectTimer) return;
  heartbeatReconnectTimer = setTimeout(() => {
    heartbeatReconnectTimer = null;
    if (heartbeatTimer === null) return;
    if (!heartbeatWs && !heartbeatBusy) {
      ensureHeartbeatSocket(bootstrap, (ws) => renewBinding(bootstrap, ws));
    }
  }, 5000);
  heartbeatReconnectTimer.unref?.();
}

function renewBinding(bootstrap, ws) {
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId || !ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  heartbeatBusy = true;
  clearHeartbeatPending();
  heartbeatPendingTimer = setTimeout(() => {
    try { ws.close(); } catch {}
  }, 5000);
  heartbeatPendingTimer.unref?.();
  try {
    ws.send(JSON.stringify({
      id: 'hb',
      method: 'antifan.cli.renewSession',
      params: {
        attachmentId: bootstrap.attachmentId,
        secret: bootstrap.secret,
        ownerPid: bootstrap.ownerPid,
        extensionMs: 7_200_000,
      },
    }));
  } catch (sendErr) {
    process.stderr.write(`[antifan-omp] heartbeat send failed: ${sendErr.message}\n`);
    clearHeartbeatPending();
    heartbeatBusy = false;
    try { ws.close(); } catch {}
  }
}

function ensureHeartbeatSocket(bootstrap, onOpen) {
  if (heartbeatWs) {
    if (onOpen && heartbeatWs.readyState === WebSocket.OPEN) onOpen(heartbeatWs);
    return heartbeatWs;
  }
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId) return null;
  const authHeaders = {};
  if (bootstrap.secret) {
    authHeaders['X-Antifan-Attachment-Secret'] = bootstrap.secret;
    authHeaders['Authorization'] = `Bearer ${bootstrap.secret}`;
  }
  if (bootstrap.token && !authHeaders['Authorization']) {
    authHeaders['Authorization'] = `Bearer ${bootstrap.token}`;
  }
  let ws;
  try {
    ws = new WebSocket(heartbeatUrl(bootstrap), { headers: authHeaders });
  } catch {
    return null;
  }
  heartbeatWs = ws;
  ws.on('message', (raw) => {
    let response;
    try {
      response = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (response.id !== 'hb') return;
    clearHeartbeatPending();
    heartbeatFailureLogged = false;
    heartbeatBusy = false;
    if (!response.success) {
      process.stderr.write(`[antifan-omp] heartbeat renew failed: ${typeof response.error === 'string' ? response.error : JSON.stringify(response.error || {})}\n`);
    }
  });
  ws.once('error', (err) => {
    if (!heartbeatFailureLogged) {
      heartbeatFailureLogged = true;
      process.stderr.write(`[antifan-omp] heartbeat error: ${err.message}\n`);
    }
  });
  ws.once('close', () => {
    clearHeartbeatPending();
    if (heartbeatWs === ws) heartbeatWs = null;
    heartbeatBusy = false;
    if (heartbeatTimer !== null) scheduleHeartbeatReconnect(bootstrap);
  });
  if (onOpen) ws.once('open', () => { if (heartbeatWs === ws) onOpen(ws); });
  return ws;
}

function startHeartbeat(bootstrap) {
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId) return;
  stopHeartbeat(); // idempotent re-bind: never leave two intervals or a stale binding
  ensureHeartbeatSocket(bootstrap, (ws) => renewBinding(bootstrap, ws));
  const heartbeatIntervalMs = Math.max(Number(process.env.ANTIFAN_HEARTBEAT_MS) || 30_000, 50);
  heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    ensureHeartbeatSocket(bootstrap, (ws) => renewBinding(bootstrap, ws));
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
}

// ─── MCP Server Initialization ───────────────────────────────────────────────
const server = new Server({ name: 'antifan-omp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allowedCaps = resolveAllowedCapabilities();
  const forbiddenCaps = resolveForbiddenCapabilities();
  const filteredDefs = (allowedCaps || forbiddenCaps)
    ? definitions.filter(([name]) => isCapabilityPermitted(name, allowedCaps, forbiddenCaps))
    : definitions;
  return {
    tools: filteredDefs.map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: 'object', properties, ...(required ? { required } : {}) },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const bootstrap = getBootstrap();
    const callerRequestId = extra && (typeof extra.requestId === 'string' || typeof extra.requestId === 'number')
      ? String(extra.requestId)
      : undefined;
    const data = await invoke(request.params.name, request.params.arguments || {}, callerRequestId);
    // Nonterminal pending-cleanup: the invocation still owns resources and has no
    // receipt yet. Surface it as a typed non-error result carrying the identity
    // required to join (re-issue with the same idempotencyKey).
    if (data && typeof data === 'object' && data._type === 'PENDING_CLEANUP') {
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    // For stat tools, directly return raw ArtifactRef metadata without hydration
    const isStat = request.params.name === 'anti.artifact.stat' ||
      request.params.name === 'artifact.stat' ||
      request.params.name === 'artifact_stat';
    if (isStat) {
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    // Screenshot capabilities return an evidence envelope ({ok, artifactRef,
    // receipt, sha256, byteLength}); older builds returned the raw ArtifactRef.
    // Both shapes resolve through the same artifact fetch.
    const ref = data && typeof data === 'object' && data.artifactRef && typeof data.artifactRef === 'object'
      ? data.artifactRef
      : data;
    const isScreenshotCapability = request.params.name === 'anti.screenshot.viewport' ||
      request.params.name === 'antifan_screenshot' ||
      request.params.name === 'anti.screenshot.full_page' ||
      request.params.name === 'anti.screenshot.fullpage' ||
      request.params.name === 'antifan_screenshot_full_page';

    // Handle ArtifactRef resolution from ArtifactStore for content-fetching capabilities
    if (ref && typeof ref === 'object' && typeof ref.id === 'string' && ref.id.startsWith('artifact-')) {
      const isImage = isScreenshotCapability ||
        (typeof ref.mime === 'string' && ref.mime.startsWith('image/'));
      if (isImage) {
        const artifactPayload = await fetchArtifactBinary(bootstrap, ref.id);
        return resolveImageArtifactResponse(ref, artifactPayload);
      }

      // If text artifact exceeds 64 KiB, return ArtifactRef metadata to prevent stdio pipe saturation
      const byteSize = typeof ref.byteLength === 'number'
        ? ref.byteLength
        : (typeof ref.bytes === 'number' ? ref.bytes : (typeof data.byteLength === 'number' ? data.byteLength : null));
      if (byteSize !== null && byteSize >= 65536) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _type: 'ArtifactRef',
                id: ref.id,
                byteLength: byteSize,
                sha256: ref.sha256 || data.sha256,
                mime: ref.mime || data.mime || 'text/plain',
                message: 'Large payload (>=64KB) preserved as ArtifactRef to prevent stdio buffer saturation. Read via artifact.read or HTTP endpoint.',
              }, null, 2),
            },
          ],
        };
      }

      // Small text artifact (<64KB)
      const artifactPayload = await fetchArtifactBinary(bootstrap, ref.id);
      const textContent = Buffer.from(artifactPayload.data, 'base64').toString('utf8');
      if (textContent.length >= 65536) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _type: 'ArtifactRef',
                id: ref.id,
                byteLength: textContent.length,
                sha256: ref.sha256 || data.sha256,
                mime: ref.mime || data.mime || 'text/plain',
                message: 'Large payload (>=64KB) preserved as ArtifactRef to prevent stdio buffer saturation. Read via artifact.read or HTTP endpoint.',
              }, null, 2),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: textContent }] };
    }

    if (isScreenshotCapability) {
      throw new Error(JSON.stringify({ code: 'CAPABILITY_ERROR', message: 'Expected ArtifactRef metadata from screenshot capability' }));
    }

    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
});
function resolveImageArtifactResponse(data, artifactPayload) {
  if (!artifactPayload || !artifactPayload.data || artifactPayload.data.length === 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: EMPTY_ARTIFACT: Image artifact payload is empty (0 bytes) for artifact '${data && data.id ? data.id : 'unknown'}'.`,
        },
      ],
    };
  }
  const detectedMime = artifactPayload.data.startsWith('/9j/')
    ? 'image/jpeg'
    : artifactPayload.data.startsWith('iVBORw0KGgo')
    ? 'image/png'
    : artifactPayload.data.startsWith('UklGR')
    ? 'image/webp'
    : (artifactPayload.mimeType || (data && data.mime) || 'image/png');
  return {
    content: [
      {
        type: 'image',
        data: artifactPayload.data,
        mimeType: detectedMime,
      },
    ],
  };
}

if (require.main === module) {
  if (process.stdin.isTTY && !process.env.ANTIFAN_MCP_BOOTSTRAP) {
    const candidates = resolveBridgeCandidates();
    if (candidates.length === 0) {
      process.stderr.write('MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge is not running.\n');
      process.exit(1);
    }
  }
  server.connect(new StdioServerTransport())
    .then(() => startHeartbeat(getBootstrap()))
    .catch((error) => {
      stopHeartbeat();
      process.stderr.write(`MCP_BRIDGE_OFFLINE: ${error}\n`);
      process.exit(1);
    });
}

module.exports = {
  resolveImageArtifactResponse,
  fetchArtifactBinary,
  definitions,
  CAPABILITY_MAP,
  DEFAULT_CLIENT_TIMEOUT_MS,
};

function shutdown() {
  stopHeartbeat();
  if (dispatchWs) {
    try { dispatchWs.close(); } catch {}
    dispatchWs = null;
  }
  for (const [, entry] of pendingDispatchCalls.entries()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(JSON.stringify({ code: 'SHUTDOWN', message: 'MCP server shutting down' })));
  }
  pendingDispatchCalls.clear();
  try { server.close(); } catch {}
}

process.stdin.on('close', shutdown);
process.stdout.on('error', shutdown);
process.stderr.on('error', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
